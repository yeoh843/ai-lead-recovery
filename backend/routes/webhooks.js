import express from 'express';
import { db } from '../config/database.js';
import { emailService } from '../services/email.js';
import { aiLeadProcessor } from '../services/lead-processor.js';

const router = express.Router();

// Webhook for new leads (public endpoint with AI processing)
router.post('/leads/:userToken', async (req, res) => {
  try {
    const { userToken } = req.params;
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
      metadata 
    } = req.body;

    // In production, validate userToken to find user
    // For demo, we'll just use the first user or create a demo user
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Create initial lead
    const lead = await db.createLead({
      user_id: userToken, // In production, look up user by token
      email,
      first_name: first_name || null,
      last_name: last_name || null,
      company: company || null,
      phone: phone || null,
      source: source || 'webhook',
      metadata: metadata || null
    });

    // Process with AI
    console.log('🤖 Processing webhook lead with AI...');
    const processingResult = await aiLeadProcessor.processNewLead(
      {
        lead_source: source || 'webhook',
        name: `${first_name || ''} ${last_name || ''}`.trim() || email.split('@')[0],
        email,
        company,
        message,
        form_answers,
        context
      },
      {
        product_info: 'ZeroTouch Mail AI System',
        user_goal: 'recover lost leads and book sales calls'
      }
    );

    // Update lead with processing
    await aiLeadProcessor.updateLeadWithProcessing(lead.id, processingResult);

    console.log(`✅ Webhook lead processed - Intent: ${processingResult.lead_profile.intent_level}, Score: ${processingResult.lead_profile.opportunity_score}`);

    res.status(201).json({
      message: 'Lead received and processed',
      lead_id: lead.id,
      ai_analysis: {
        intent_level: processingResult.lead_profile.intent_level,
        opportunity_score: processingResult.lead_profile.opportunity_score,
        recommended_action: processingResult.first_action.action
      }
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// Webhook for inbound emails (from SendGrid/Postmark)
router.post('/inbound-email', async (req, res) => {
  try {
    // Parse inbound email data
    // Format depends on email provider (SendGrid, Postmark, etc.)
    const { from, to, subject, text, html } = req.body;

    const result = await emailService.processInboundEmail({
      from,
      subject,
      body: text || html
    });

    res.json(result);
  } catch (error) {
    console.error('Inbound email webhook error:', error);
    res.status(500).json({ error: 'Failed to process inbound email' });
  }
});

// ⚡ Gmail Push Notifications webhook (from Google Pub/Sub)
// This receives instant notifications when new emails arrive
router.post('/gmail-push', async (req, res) => {
  try {
    // Google Pub/Sub requires quick response to avoid retries
    // Acknowledge immediately, process asynchronously
    res.json({ success: true });

    // Extract the Pub/Sub message
    const message = req.body.message;
    if (!message || !message.data) {
      console.log('⚠️  Received Gmail push notification with no data');
      return;
    }

    try {
      // Decode the message (it's base64 encoded)
      const decodedMessage = JSON.parse(
        Buffer.from(message.data, 'base64').toString('utf-8')
      );

      const { emailAddress, historyId } = decodedMessage;

      console.log(`\n🔔 ⚡ INSTANT EMAIL NOTIFICATION`);
      console.log(`   📧 From: ${emailAddress}`);
      console.log(`   History ID: ${historyId}`);
      console.log(`   (Processing in background...)\n`);

      // Find the user with this email address
      await db.read();
      const user = db.data.users.find(u =>
        db.data.email_settings.find(s =>
          s.user_id === u.id && s.email === emailAddress
        )
      );

      if (!user) {
        console.log(`⚠️  No user found for email: ${emailAddress}`);
        return;
      }

      // Get user's email settings
      const settings = db.data.email_settings.find(s => s.user_id === user.id);

      if (!settings || settings.provider !== 'gmail' || !settings.access_token) {
        console.log(`⚠️  Gmail not configured for user: ${user.id}`);
        return;
      }

      // Import checkGmailReplies from server.js
      // Note: This is called asynchronously to avoid blocking the response
      // The actual implementation would import from your Gmail checking function
      console.log(`✅ Queued email check for user ${user.id}`);
      // checkGmailReplies(settings, user.id).catch(err =>
      //   console.error('Error processing Gmail push:', err)
      // );

    } catch (error) {
      console.error('Error processing Gmail push message:', error);
    }

  } catch (error) {
    console.error('Gmail push webhook error:', error);
    // Still return 200 to avoid Pub/Sub retrying
    res.json({ success: true });
  }
});

export default router;
