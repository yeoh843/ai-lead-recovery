import express from 'express';
import { db } from '../config/database.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Get all sequences
router.get('/', authenticateToken, async (req, res) => {
  try {
    const sequences = await db.getSequences(req.userId);
    res.json({ sequences });
  } catch (error) {
    console.error('Get sequences error:', error);
    res.status(500).json({ error: 'Failed to get sequences' });
  }
});

// Get single sequence with steps
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const sequence = await db.findSequenceById(req.params.id);
    
    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }

    if (sequence.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const steps = await db.getSequenceSteps(sequence.id);

    res.json({
      sequence,
      steps
    });
  } catch (error) {
    console.error('Get sequence error:', error);
    res.status(500).json({ error: 'Failed to get sequence' });
  }
});

// Create sequence
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, steps } = req.body;

    if (!name || !steps || !Array.isArray(steps)) {
      return res.status(400).json({ error: 'Name and steps array required' });
    }

    // Create sequence
    const sequence = await db.createSequence({
      user_id: req.userId,
      name,
      description: description || null
    });

    // Create steps
    const createdSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const step = await db.createSequenceStep({
        sequence_id: sequence.id,
        step_number: i,
        delay_days: steps[i].delay_days || 0,
        email_template: steps[i].email_template || '',
        ai_personalization_enabled: steps[i].ai_personalization_enabled !== false,
        stop_on_reply: steps[i].stop_on_reply !== false
      });
      createdSteps.push(step);
    }

    res.status(201).json({
      message: 'Sequence created successfully',
      sequence,
      steps: createdSteps
    });
  } catch (error) {
    console.error('Create sequence error:', error);
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

// Update sequence
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const sequence = await db.findSequenceById(req.params.id);
    
    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }

    if (sequence.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { name, description, is_active } = req.body;
    const updated = await db.updateSequence(req.params.id, {
      name,
      description,
      is_active
    });

    res.json({
      message: 'Sequence updated successfully',
      sequence: updated
    });
  } catch (error) {
    console.error('Update sequence error:', error);
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

// Delete sequence
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const sequence = await db.findSequenceById(req.params.id);
    
    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }

    if (sequence.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.deleteSequence(req.params.id);

    res.json({ message: 'Sequence deleted successfully' });
  } catch (error) {
    console.error('Delete sequence error:', error);
    res.status(500).json({ error: 'Failed to delete sequence' });
  }
});

export default router;
