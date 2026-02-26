import express from 'express';
import { db } from '../config/database.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Get dashboard analytics
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const analytics = await db.getAnalytics(req.userId);
    res.json(analytics);
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

export default router;
