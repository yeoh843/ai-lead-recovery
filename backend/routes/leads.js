import express from 'express';
import { db } from '../config/database.js';
import { authenticateToken } from './auth.js';
import { enrollLeadInSequence } from '../services/scheduler.js';
import { aiLeadProcessor } from '../services/lead-processor.js';

const router = express.Router();

// Get all leads
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, ai_intent } = req.query;
    const leads = await db.getLeads(req.userId, { status, ai_intent });

    res.json({
      leads,
      total: leads.length
    });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Failed to get leads' });
  }
});

// Get single lead
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const lead = await db.findLeadById(req.params.id);
    
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (lead.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get interactions
    const interactions = await db.getEmailInteractions(lead.id);

    res.json({
      lead,
      interactions
    });
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ error: 'Failed to get lead' });
  }
});

// Create lead with AI processing
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { 
      email, 
      first_name, 
      last_name, 
      company, 
      phone, 
      source, 
      message,
      form_answers,
      context,
      metadata,
      // Business context (optional)
      product_info,
      user_goal
    } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if lead already exists
    const existing = await db.findLeadByEmail(email);
    if (existing && existing.user_id === req.userId) {
      return res.status(400).json({ error: 'Lead with this email already exists' });
    }

    // Create initial lead
    const lead = await db.createLead({
      user_id: req.userId,
      email,
      first_name: first_name || null,
      last_name: last_name || null,
      company: company || null,
      phone: phone || null,
      source: source || 'manual',
      metadata: metadata || null
    });

    // Process lead with AI
    console.log('🤖 Processing new lead with AI...');
    const processingResult = await aiLeadProcessor.processNewLead(
      {
        lead_source: source || 'manual',
        name: `${first_name || ''} ${last_name || ''}`.trim() || email.split('@')[0],
        email,
        company,
        message,
        form_answers,
        context
      },
      {
        product_info: product_info || 'ZeroTouch Mail AI System',
        user_goal: user_goal || 'recover lost leads and book sales calls'
      }
    );

    // Update lead with AI processing results
    await aiLeadProcessor.updateLeadWithProcessing(lead.id, processingResult);

    console.log('✅ Lead processed:');
    console.log(`   - Intent Level: ${processingResult.lead_profile.intent_level}`);
    console.log(`   - Buying Stage: ${processingResult.lead_profile.buying_stage}`);
    console.log(`   - Opportunity Score: ${processingResult.lead_profile.opportunity_score}`);
    console.log(`   - Recommended Action: ${processingResult.first_action.action}`);

    // Get updated lead
    const updatedLead = await db.findLeadById(lead.id);

    res.status(201).json({
      message: 'Lead created and processed successfully',
      lead: updatedLead,
      ai_analysis: processingResult
    });
  } catch (error) {
    console.error('Create lead error:', error);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

// Update lead
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const lead = await db.findLeadById(req.params.id);
    
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (lead.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updated = await db.updateLead(req.params.id, req.body);

    res.json({
      message: 'Lead updated successfully',
      lead: updated
    });
  } catch (error) {
    console.error('Update lead error:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

// Delete lead
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const lead = await db.findLeadById(req.params.id);
    
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (lead.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.deleteLead(req.params.id);

    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

// Enroll lead in sequence
router.post('/:id/enroll', authenticateToken, async (req, res) => {
  try {
    const { sequence_id } = req.body;

    if (!sequence_id) {
      return res.status(400).json({ error: 'Sequence ID required' });
    }

    const lead = await db.findLeadById(req.params.id);
    if (!lead || lead.user_id !== req.userId) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const sequence = await db.findSequenceById(sequence_id);
    if (!sequence || sequence.user_id !== req.userId) {
      return res.status(404).json({ error: 'Sequence not found' });
    }

    await enrollLeadInSequence(req.params.id, sequence_id);

    res.json({
      message: 'Lead enrolled in sequence',
      lead_id: req.params.id,
      sequence_id
    });
  } catch (error) {
    console.error('Enroll lead error:', error);
    res.status(500).json({ error: 'Failed to enroll lead' });
  }
});

// Import leads from CSV (simplified)
router.post('/import', authenticateToken, async (req, res) => {
  try {
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Leads array required' });
    }

    const imported = [];
    const errors = [];

    for (const leadData of leads) {
      try {
        if (!leadData.email) {
          errors.push({ data: leadData, error: 'Missing email' });
          continue;
        }

        const lead = await db.createLead({
          user_id: req.userId,
          ...leadData,
          source: 'csv_import'
        });

        imported.push(lead);
      } catch (error) {
        errors.push({ data: leadData, error: error.message });
      }
    }

    res.json({
      message: 'Import completed',
      imported: imported.length,
      errors: errors.length,
      leads: imported,
      failed: errors
    });
  } catch (error) {
    console.error('Import leads error:', error);
    res.status(500).json({ error: 'Failed to import leads' });
  }
});

export default router;
