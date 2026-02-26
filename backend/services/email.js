import { db } from '../config/database.js';
import { aiService } from './ai.js';

export class EmailService {
  /**
   * Send personalized follow-up email
   * NOTE: This service currently logs emails but doesn't send them.
   * For production: Configure email settings in the app and use the sendEmail function in server.js
   * which supports real SMTP sending via nodemailer.
   */
  async sendFollowUpEmail(lead, emailContent, metadata = {}) {
    try {
      console.log(`📧 Email would be sent to ${lead.email}:`);
      console.log(`   Subject: ${emailContent.subject}`);
      console.log(`   Preview: ${emailContent.body.substring(0, 100)}...`);

      // Log attachments if present
      if (metadata.attachments && metadata.attachments.length > 0) {
        console.log(`   📎 Attachments: ${metadata.attachments.length} file(s)`);
        metadata.attachments.forEach(att => {
          console.log(`      - ${att.filename} (${(att.size / 1024).toFixed(1)} KB)`);
        });
      }

      console.log(`   ⚠️  To actually send emails, configure SMTP settings in the app.`);

      // Log sent email
      const interaction = await db.createEmailInteraction({
        lead_id: lead.id,
        sequence_id: metadata.sequence_id,
        step_number: metadata.step_number,
        direction: 'sent',
        subject: emailContent.subject,
        body: emailContent.body,
        attachments: metadata.attachments || [],
        sent_at: new Date().toISOString()
      });

      return {
        success: true,
        interaction_id: interaction.id,
        message: 'Email logged (configure SMTP in app settings to send real emails)'
      };
    } catch (error) {
      console.error('Email Send Error:', error);
      throw error;
    }
  }

  /**
   * Process inbound email reply
   */
  async processInboundEmail(inboundData) {
    try {
      const { from, subject, body } = inboundData;

      // Find the lead
      const lead = await db.findLeadByEmail(from);
      if (!lead) {
        console.log('Reply from unknown email:', from);
        return { success: false, error: 'Lead not found' };
      }

      // Clean email body
      const cleanBody = this.cleanEmailBody(body);

      // Run AI intent detection (subject + body both analyzed)
      const intent = await aiService.detectIntent(cleanBody, subject);

      // Log the reply
      await db.createEmailInteraction({
        lead_id: lead.id,
        direction: 'received',
        subject: subject,
        body: cleanBody,
        ai_intent_detected: intent.category,
        ai_confidence: intent.confidence,
        replied_at: new Date().toISOString()
      });

      // Update lead status
      await db.updateLead(lead.id, {
        status: 'replied',
        ai_intent: intent.category,
        last_interaction: new Date().toISOString()
      });

      // Execute next action based on intent
      await this.executeNextAction(lead, intent);

      return {
        success: true,
        intent: intent.category,
        lead_id: lead.id
      };
    } catch (error) {
      console.error('Inbound Email Processing Error:', error);
      throw error;
    }
  }

  /**
   * Execute next action based on AI intent
   */
  async executeNextAction(lead, intent) {
    console.log(`🤖 AI detected ${intent.category} intent for ${lead.email}`);
    console.log(`   Suggested action: ${intent.suggested_action}`);

    const actions = {
      INTERESTED: async () => {
        // Pause sequence & notify user
        await db.updateLead(lead.id, { 
          status: 'interested',
          sequence_paused: true 
        });
        console.log(`🔥 HOT LEAD: ${lead.first_name} is interested!`);
      },

      NOT_NOW: async () => {
        // Schedule long-term nurture (45 days)
        await db.updateLead(lead.id, { 
          status: 'not_now',
          next_followup: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
        });
        console.log(`⏰ Scheduled ${lead.first_name} for follow-up in 45 days`);
      },

      OBJECTION: async () => {
        // Mark for objection handling
        await db.updateLead(lead.id, { 
          status: 'objection',
          objection_subtype: intent.key_phrases ? intent.key_phrases.join(', ') : ''
        });
        console.log(`❓ ${lead.first_name} has objections: ${intent.key_phrases.join(', ')}`);
      },

      GHOSTING: async () => {
        // Continue sequence
        console.log(`👻 ${lead.first_name} gave vague response - continuing sequence`);
      },

      DEAD: async () => {
        // Stop all sequences
        await db.updateLead(lead.id, { 
          status: 'dead',
          sequence_paused: true 
        });
        console.log(`❌ ${lead.first_name} opted out`);
      }
    };

    const action = actions[intent.category];
    if (action) {
      await action();
    }
  }

  /**
   * Clean email body (remove signatures, quoted text)
   */
  cleanEmailBody(rawBody) {
    let clean = rawBody;

    // Remove common signature patterns
    clean = clean.split(/(?:--|Sent from|Get Outlook|On.*wrote:)/i)[0];

    // Remove quoted text
    clean = clean
      .split('\n')
      .filter(line => !line.trim().startsWith('>') && !line.trim().startsWith('|'))
      .join('\n');

    // Remove excessive whitespace
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }
}

export const emailService = new EmailService();
