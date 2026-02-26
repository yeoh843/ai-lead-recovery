import { db } from '../config/database.js';
import { aiService } from './ai.js';
import { emailService } from './email.js';

/**
 * Check for scheduled emails that are due to be sent
 */
export async function checkScheduledEmails() {
  try {
    // Get all active leads with sequences
    const allLeads = await db.getLeads();
    const activeLeads = allLeads.filter(lead => 
      lead.status !== 'dead' && 
      lead.status !== 'converted' &&
      !lead.sequence_paused &&
      lead.sequence_id
    );

    console.log(`📊 Checking ${activeLeads.length} active leads for scheduled emails`);

    for (const lead of activeLeads) {
      await processLeadSequence(lead);
    }

    return { processed: activeLeads.length };
  } catch (error) {
    console.error('Scheduler error:', error);
    throw error;
  }
}

/**
 * Process a single lead's sequence
 */
async function processLeadSequence(lead) {
  try {
    // Get the sequence
    const sequence = await db.findSequenceById(lead.sequence_id);
    if (!sequence || !sequence.is_active) {
      return;
    }

    // Get sequence steps
    const steps = await db.getSequenceSteps(sequence.id);
    if (!steps || steps.length === 0) {
      return;
    }

    // Get current step
    const currentStep = lead.current_step || 0;
    if (currentStep >= steps.length) {
      console.log(`✅ Lead ${lead.email} completed sequence`);
      await db.updateLead(lead.id, { 
        status: 'sequence_completed',
        sequence_paused: true 
      });
      return;
    }

    const step = steps[currentStep];

    // Check if it's time to send
    const interactions = await db.getEmailInteractions(lead.id);
    const lastSent = interactions
      .filter(i => i.direction === 'sent')
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];

    let shouldSend = false;

    if (!lastSent) {
      // First email - check if delay has passed since enrollment
      const enrollmentTime = lead.sequence_started_at
        ? new Date(lead.sequence_started_at).getTime()
        : new Date(lead.updated_at).getTime();

      const daysSinceEnrollment = Math.floor(
        (Date.now() - enrollmentTime) / (1000 * 60 * 60 * 24)
      );

      if (daysSinceEnrollment >= step.delay_days) {
        shouldSend = true;
      }
    } else {
      // Check if delay has passed since last email
      const daysSinceLastEmail = Math.floor(
        (Date.now() - new Date(lastSent.sent_at).getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysSinceLastEmail >= step.delay_days) {
        shouldSend = true;
      }
    }

    if (shouldSend) {
      console.log(`📤 Sending step ${currentStep + 1} to ${lead.email}`);

      // Generate personalized email
      const personalizedEmail = await aiService.generatePersonalizedEmail(lead, step.email_template);

      // Send email with attachments
      await emailService.sendFollowUpEmail(lead, personalizedEmail, {
        sequence_id: sequence.id,
        step_number: currentStep,
        attachments: step.attachments || []
      });

      // Update lead to next step
      await db.updateLead(lead.id, {
        current_step: currentStep + 1,
        last_interaction: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error(`Error processing lead ${lead.id}:`, error);
  }
}

/**
 * Enroll a lead in a sequence
 */
export async function enrollLeadInSequence(leadId, sequenceId) {
  try {
    await db.updateLead(leadId, {
      sequence_id: sequenceId,
      current_step: 0,
      status: 'active',
      sequence_paused: false,
      sequence_started_at: new Date().toISOString()
    });

    console.log(`✅ Enrolled lead ${leadId} in sequence ${sequenceId}`);
    
    // Trigger immediate processing to send first email
    const lead = await db.findLeadById(leadId);
    if (lead) {
      await processLeadSequence(lead);
    }

    return { success: true };
  } catch (error) {
    console.error('Error enrolling lead:', error);
    throw error;
  }
}
