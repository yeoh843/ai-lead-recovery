       import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import dotenv from 'dotenv';
import mammoth from 'mammoth';
import { load as cheerioLoad } from 'cheerio';
import fetch from 'node-fetch';
import multer from 'multer';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';

dotenv.config();

// ─── Stripe Setup ─────────────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// Plan limits — keyed by plan name
const PLANS = {
  trial: {
    name: 'Free Trial',
    active_leads_limit: 300,
    ai_generations_limit: 50,
    sequences_limit: 3
  },
  starter: {
    name: 'Starter',
    price_monthly: 2900,  // cents
    price_annual: 27900,  // cents
    active_leads_limit: 300,
    ai_generations_limit: 600,
    sequences_limit: 3
  },
  growth: {
    name: 'Growth',
    price_monthly: 7900,
    price_annual: 75900,
    active_leads_limit: null,  // unlimited
    ai_generations_limit: 3000,
    sequences_limit: null  // unlimited
  }
};

// Free (personal) email domains — block on registration
const FREE_EMAIL_DOMAINS = [
  'gmail.com','yahoo.com','hotmail.com','outlook.com','live.com',
  'icloud.com','aol.com','protonmail.com','mail.com','yandex.com',
  'gmx.com','zoho.com','yahoo.co.uk','yahoo.com.au','msn.com',
  'me.com','mac.com','googlemail.com','yahoo.fr','yahoo.de'
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Google OAuth client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for email attachments
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve frontend static files (must be BEFORE the URL rewrite middleware below)
app.use(express.static(path.join(__dirname, '../frontend')));

// Serve index.html for SPA client-side routes (before URL rewrite so they don't get mangled)
['/settings', '/inbox-hub', '/inbox', '/emails', '/reviews', '/sequences', '/templates', '/billing', '/appointments'].forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
  });
});

// Support routes both with and without /api/ prefix
// Frontend calls /auth/login, /leads etc. but routes are defined as /api/auth/login, /api/leads
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && req.path !== '/health') {
    req.url = '/api' + req.url;
  }
  next();
});

const adapter = new JSONFile('db.json');
const db = new Low(adapter, {});

await db.read();
db.data ||= {
  users: [],
  leads: [],
  sequences: [],
  sequence_steps: [],
  campaigns: [],
  email_events: [],
  lead_sources: [],
  email_settings: [],
  ai_drafts: [],
  email_threads: [],
  email_history: [], // Track all sent emails (initial + follow-ups)
  product_profiles: [], // Store product/service information for AI email generation
  seller_profiles: [],  // Seller's own contact info — kept separate from product docs
  email_templates: [], // Unlayer email templates with design JSON and HTML
  winning_emails: [],  // Emails that triggered positive replies — used for AI learning
  ab_results: []       // A/B test tracking: which email style wins per user per intent
};

// Ensure new tables exist for older installs
if (!db.data.winning_emails) db.data.winning_emails = [];
if (!db.data.ab_results) db.data.ab_results = [];
if (!db.data.appointments) db.data.appointments = [];

// Write to ensure db.json is created with default schema
await db.write();

// Billing migrations — add billing fields to existing users and ensure subscriptions exists
if (!db.data.subscriptions) db.data.subscriptions = [];
if (db.data.users && db.data.users.length > 0) {
  let billingMigrationNeeded = false;
  const trialDays = 14;
  db.data.users = db.data.users.map(user => {
    if (!user.plan) {
      const trialEnd = new Date(new Date(user.created_at || new Date()).getTime() + trialDays * 24 * 60 * 60 * 1000);
      user.plan = 'trial';
      user.plan_status = 'trialing';
      user.trial_ends_at = trialEnd.toISOString();
      user.stripe_customer_id = null;
      user.stripe_subscription_id = null;
      user.ai_generations_this_month = 0;
      user.ai_generations_reset_at = new Date().toISOString();
      billingMigrationNeeded = true;
    }
    return user;
  });
  if (billingMigrationNeeded) {
    console.log('✓ Migrated existing users with billing/trial fields');
  }
}

// Ensure product_profiles exists even in older databases
if (!db.data.product_profiles) {
  db.data.product_profiles = [];
}

// Ensure seller_profiles exists in older databases
if (!db.data.seller_profiles) {
  db.data.seller_profiles = [];
}

// Ensure email_templates exists
if (!db.data.email_templates) {
  db.data.email_templates = [];
}

// Migrate email_history records to include html_body and attachments fields
if (db.data.email_history && db.data.email_history.length > 0) {
  let migrationNeeded = false;
  db.data.email_history = db.data.email_history.map(record => {
    if (!record.html_body) {
      record.html_body = record.body ? record.body.replace(/\n/g, '<br>') : '';
      migrationNeeded = true;
    }
    if (!record.attachments) {
      record.attachments = [];
      migrationNeeded = true;
    }
    return record;
  });
  if (migrationNeeded) {
    console.log('✓ Migrated email_history records to include html_body and attachments fields');
  }
}

// Migrate email_threads to include notified field for notification system
if (db.data.email_threads && db.data.email_threads.length > 0) {
  let migrationNeeded = false;
  db.data.email_threads = db.data.email_threads.map(thread => {
    if (thread.notified === undefined) {
      thread.notified = true; // Mark existing threads as already notified to avoid spam
      migrationNeeded = true;
    }
    return thread;
  });
  if (migrationNeeded) {
    console.log('✓ Migrated email_threads to include notified field for notifications');
  }
}

// Migrate users to unified auto_mode_enabled setting
if (db.data.users && db.data.users.length > 0) {
  let migrationNeeded = false;
  db.data.users = db.data.users.map(user => {
    if (user.auto_mode_enabled === undefined) {
      // Consolidate existing auto-send settings into new unified auto_mode_enabled
      user.auto_mode_enabled = (user.email_mode === 'AUTO' || user.auto_send_all === true);
      user.auto_mode_include_objections = false; // Default to safe behavior - require manual review for objections
      migrationNeeded = true;
    }
    return user;
  });
  if (migrationNeeded) {
    console.log('✓ Migrated users to unified auto_mode_enabled setting');
  }
}

// Startup cleanup: resolve stale Action Required drafts for leads that already have
// a newer correct (non-clarification) pending draft. This clears old holding-reply
// drafts that were created before the AI was improved to answer product questions.
if (db.data.ai_drafts && db.data.ai_drafts.length > 0) {
  let staleResolved = 0;
  const pendingDrafts = db.data.ai_drafts.filter(d => d.status === 'pending');
  pendingDrafts.forEach(d => {
    if (!d.needs_follow_up && !d.clarification_needed) {
      // This is a correct draft — resolve any older stale Action Required drafts for the same lead
      db.data.ai_drafts.forEach(old => {
        if (
          old.lead_id === d.lead_id &&
          old.status === 'pending' &&
          (old.needs_follow_up || old.clarification_needed) &&
          new Date(old.created_at) < new Date(d.created_at)
        ) {
          old.status = 'resolved';
          staleResolved++;
        }
      });
    }
  });
  if (staleResolved > 0) {
    console.log(`✓ Resolved ${staleResolved} stale Action Required draft(s) — leads already have correct AI replies`);
  }
}

await db.write();

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ─── Plan Helpers ─────────────────────────────────────────────────────────────

// Get the effective plan for a user (handles expired trials)
function getUserPlan(user) {
  if (!user) return { plan: 'trial', status: 'expired', limits: PLANS.trial };
  const plan = user.plan || 'trial';
  let status = user.plan_status || 'trialing';
  if (plan === 'trial' && user.trial_ends_at && new Date() > new Date(user.trial_ends_at)) {
    status = 'expired';
  }
  return { plan, status, limits: PLANS[plan] || PLANS.trial };
}

// Check if user is on active plan (trial not expired, or paid subscription active)
function isPlanActive(user) {
  const { plan, status } = getUserPlan(user);
  if (status === 'expired') return false;
  if (plan === 'trial' && status === 'trialing') return true;
  return status === 'active';
}

// Reset monthly AI generation counter if a new month started
async function resetMonthlyCounterIfNeeded(user) {
  const now = new Date();
  const resetAt = user.ai_generations_reset_at ? new Date(user.ai_generations_reset_at) : new Date(0);
  if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
    user.ai_generations_this_month = 0;
    user.ai_generations_reset_at = now.toISOString();
    return true;
  }
  return false;
}

// Middleware: block access if plan expired
const requireActivePlan = async (req, res, next) => {
  await db.read();
  const user = db.data.users.find(u => u.id === req.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!isPlanActive(user)) {
    return res.status(402).json({
      error: 'plan_expired',
      message: 'Your free trial has expired. Please upgrade to continue.',
      upgrade_url: '/billing'
    });
  }
  next();
};

// Health check endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// DEBUG: Test intent classification directly
app.post('/api/test-classify', async (req, res) => {
  const { text, subject = '' } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  console.log('\n=== TESTING CLASSIFICATION ===');
  const analysis = await analyzeReplyWithAI(text, subject);
  console.log(`Input: "${text}"`);
  if (subject) console.log(`Subject: "${subject}"`);
  console.log(`Result: ${analysis.intent}`);
  console.log(`Reasoning: ${analysis.reasoning}`);
  console.log('=============================\n');

  res.json(analysis);
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, company_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  // Allow any email domain (commented out to allow public signups)
  // const emailDomain = email.split('@')[1]?.toLowerCase();
  // if (!emailDomain || FREE_EMAIL_DOMAINS.includes(emailDomain)) {
  //   return res.status(400).json({ error: 'Please use your business email address to sign up.' });
  // }

  await db.read();

  // Ensure all tables exist after read (in case db.json is empty on fresh deployments)
  if (!db.data) db.data = {};
  if (!db.data.users) db.data.users = [];
  if (!db.data.leads) db.data.leads = [];
  if (!db.data.sequences) db.data.sequences = [];
  if (!db.data.sequence_steps) db.data.sequence_steps = [];
  if (!db.data.email_settings) db.data.email_settings = [];

  if ((db.data.users || []).find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days
  const user = {
    id: (db.data.users || []).length + 1,
    email,
    password: hashedPassword,
    company_name: company_name || '',
    created_at: new Date().toISOString(),
    // Billing fields
    plan: 'trial',
    plan_status: 'trialing',
    trial_ends_at: trialEnd.toISOString(),
    stripe_customer_id: null,
    stripe_subscription_id: null,
    ai_generations_this_month: 0,
    ai_generations_reset_at: new Date().toISOString()
  };

  db.data.users.push(user);
  await db.write();

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, company_name: user.company_name } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  await db.read();
  const user = (db.data.users || []).find(u => u.email === email);

  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, company_name: user.company_name } });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    await db.read();
    const user = (db.data.users || []).find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Calculate active leads for this user (safe with try/catch)
    let activeLeads = 0;
    try {
      activeLeads = (db.data.leads || []).filter(l =>
        l.user_id === req.userId &&
        l.enrolled_sequence_id &&
        !l.sequence_completed &&
        l.status !== 'dead'
      ).length;
    } catch(e) { /* ignore lead count errors */ }

    // Effective plan (trial expired → locked)
    let effectivePlan = user.plan || 'trial';
    let planStatus = user.plan_status || 'trialing';
    if (effectivePlan === 'trial' && user.trial_ends_at && new Date() > new Date(user.trial_ends_at)) {
      planStatus = 'expired';
    }

    const planLimits = PLANS[effectivePlan] || PLANS.trial;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        company_name: user.company_name,
        plan: effectivePlan,
        plan_status: planStatus,
        trial_ends_at: user.trial_ends_at || null,
        ai_generations_this_month: user.ai_generations_this_month || 0,
        ai_generations_limit: planLimits.ai_generations_limit,
        active_leads_count: activeLeads,
        active_leads_limit: planLimits.active_leads_limit,
        sequences_limit: planLimits.sequences_limit
      }
    });
  } catch (err) {
    console.error('/api/auth/me error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Google OAuth - Step 1: Initiate OAuth flow
app.get('/api/auth/google', authenticate, (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Force consent screen to always get refresh_token
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state: req.userId.toString() // Pass user ID to callback
  });

  res.json({ authUrl });
});

// Google OAuth - Step 2: Handle callback
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const userId = parseInt(state);

    if (!code || !userId) {
      return res.redirect('http://localhost:3000/settings?error=oauth_failed');
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    // Get user email from Google
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    // Save tokens to database
    await db.read();
    const existingSettings = db.data.email_settings.find(s => s.user_id === userId);

    const emailSettings = {
      user_id: userId,
      email: data.email,
      from_name: existingSettings?.from_name || '',
      sending_mode: existingSettings?.sending_mode || 'manual',
      provider: 'gmail',
      access_token: tokens.access_token,
      token_expiry: tokens.expiry_date,
      auto_send_enabled: existingSettings?.auto_send_enabled ?? false
    };

    // Only update refresh_token if Google returned a new one (on first auth or explicit reconsent)
    if (tokens.refresh_token) {
      emailSettings.refresh_token = tokens.refresh_token;
    }

    if (existingSettings) {
      Object.assign(existingSettings, emailSettings);
      // Preserve existing refresh_token if a new one wasn't provided
      if (!tokens.refresh_token && existingSettings.refresh_token) {
        // refresh_token already preserved by Object.assign
      }
      // Clear the invalid flag since user just reconnected with fresh tokens
      delete existingSettings.token_invalid;
      delete existingSettings.token_invalid_since;
    } else {
      emailSettings.id = db.data.email_settings.length + 1;
      db.data.email_settings.push(emailSettings);
    }

    await db.write();

    // Redirect back to frontend (served from backend on port 3000)
    res.redirect('http://localhost:3000/settings?success=gmail_connected');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('http://localhost:3000/settings?error=oauth_failed');
  }
});

app.get('/api/leads', authenticate, async (req, res) => {
  await db.read();
  let leads = db.data.leads.filter(l => l.user_id === req.userId);

  if (req.query.ai_intent) {
    leads = leads.filter(l => l.ai_intent === req.query.ai_intent);
  }
  if (req.query.status) {
    leads = leads.filter(l => l.status === req.query.status);
  }

  // Sort leads by most recent activity: last email received, then by created_at
  leads.sort((a, b) => {
    const aDate = a.last_reply_date || a.created_at || '';
    const bDate = b.last_reply_date || b.created_at || '';
    return bDate.localeCompare(aDate);
  });

  // Remove backend-only fields before sending to frontend
  // Also attach the latest email thread's subject for preview
  const sanitizedLeads = leads.map(lead => {
    const { ai_paused_by_human, last_email_sender, ...safeData } = lead;

    // Find latest thread for this lead to get the subject
    const threads = (db.data.email_threads || []).filter(t => t.lead_id === lead.id);
    if (threads.length > 0) {
      const latest = threads.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0];
      safeData.last_subject = latest.subject || '(No Subject)';
    }

    // Attach sequence name and total steps if enrolled
    if (lead.enrolled_sequence_id) {
      const seq = (db.data.sequences || []).find(s => s.id === lead.enrolled_sequence_id);
      if (seq) {
        safeData.sequence_name = seq.name;
        safeData.total_sequence_steps = (db.data.sequence_steps || []).filter(s => s.sequence_id === seq.id).length;
      }
    }

    return safeData;
  });

  res.json({ leads: sanitizedLeads });
});

app.post('/api/leads', authenticate, async (req, res) => {
  const { email, first_name, last_name, company, phone } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  await db.read();
  const lead = {
    id: db.data.leads.length + 1,
    user_id: req.userId,
    email,
    first_name: first_name || '',
    last_name: last_name || '',
    company: company || '',
    phone: phone || '',
    status: 'new',
    ai_intent: null,
    created_at: new Date().toISOString()
  };

  db.data.leads.push(lead);
  await db.write();
  res.json({ lead });
});

app.post('/api/leads/bulk', authenticate, async (req, res) => {
  const { leads } = req.body;
  if (!leads || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Invalid leads array' });
  }

  await db.read();
  let successCount = 0;
  let failedCount = 0;

  leads.forEach(leadData => {
    if (!leadData.email) {
      failedCount++;
      return;
    }

    const lead = {
      id: db.data.leads.length + 1,
      user_id: req.userId,
      email: leadData.email,
      first_name: leadData.first_name || '',
      last_name: leadData.last_name || '',
      company: leadData.company || '',
      phone: leadData.phone || '',
      status: 'new',
      ai_intent: null,
      created_at: new Date().toISOString()
    };

    db.data.leads.push(lead);
    successCount++;
  });

  await db.write();
  res.json({ success: successCount, failed: failedCount });
});

app.get('/api/sequences', authenticate, async (req, res) => {
  await db.read();
  const sequences = db.data.sequences.filter(s => s.user_id === req.userId);
  const enriched = sequences.map(seq => {
    const steps = (db.data.sequence_steps || []).filter(s => s.sequence_id === seq.id);
    const enrolled = (db.data.leads || []).filter(l =>
      l.enrolled_sequence_id === seq.id && l.user_id === req.userId
    );
    return {
      ...seq,
      step_count: steps.length,
      active_leads_count: enrolled.filter(l => !l.sequence_completed).length,
      completed_leads_count: enrolled.filter(l => l.sequence_completed === true).length,
      total_enrolled: enrolled.length,
      // step_subjects is used by the search bar in the Sequences page to search email content
      step_subjects: steps.map(s => s.subject || ''),
      // step_bodies stripped to plain text for search — strip HTML tags so keywords are findable
      step_bodies: steps.map(s => (s.email_template || '').replace(/<[^>]*>/g, ' ')),
    };
  });
  res.json({ sequences: enriched });
});

app.post('/api/sequences', authenticate, async (req, res) => {
  const { name, description, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'Sequence name is required' });

  await db.read();
  const sequence = {
    id: db.data.sequences.length + 1,
    user_id: req.userId,
    name,
    description: description || '',
    is_active: true,
    created_at: new Date().toISOString()
  };

  db.data.sequences.push(sequence);

  if (steps && Array.isArray(steps)) {
    steps.forEach((step, index) => {
      db.data.sequence_steps.push({
        id: db.data.sequence_steps.length + 1,
        sequence_id: sequence.id,
        step_number: index + 1,
        delay_days: step.delay_days || 0,
        delay_unit: step.delay_unit || 'days',
        subject: step.subject || '',
        email_template: step.email_template || '',
        attachments: step.attachments || [],
        stop_on_reply: step.stop_on_reply !== false
      });
    });
  }

  await db.write();
  res.json({ sequence });
});

// Get single sequence with steps
app.get('/api/sequences/:id', authenticate, async (req, res) => {
  await db.read();
  const sequence = db.data.sequences.find(s => s.id === parseInt(req.params.id));

  if (!sequence) {
    return res.status(404).json({ error: 'Sequence not found' });
  }

  if (sequence.user_id !== req.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const steps = db.data.sequence_steps
    .filter(s => s.sequence_id === sequence.id)
    .sort((a, b) => a.step_number - b.step_number);

  res.json({ sequence, steps });
});

// Update sequence
app.patch('/api/sequences/:id', authenticate, async (req, res) => {
  await db.read();
  const sequence = db.data.sequences.find(s => s.id === parseInt(req.params.id));

  if (!sequence) {
    return res.status(404).json({ error: 'Sequence not found' });
  }

  if (sequence.user_id !== req.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { name, description, is_active } = req.body;

  if (name !== undefined) sequence.name = name;
  if (description !== undefined) sequence.description = description;
  if (is_active !== undefined) sequence.is_active = is_active;

  await db.write();
  res.json({ sequence });
});

// Update sequence with steps (full edit)
app.put('/api/sequences/:id', authenticate, async (req, res) => {
  await db.read();
  const seqId = parseInt(req.params.id);
  const sequence = db.data.sequences.find(s => s.id === seqId);

  if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
  if (sequence.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  const { name, description, is_active, steps } = req.body;
  if (name !== undefined) sequence.name = name;
  if (description !== undefined) sequence.description = description;
  if (is_active !== undefined) sequence.is_active = is_active;

  // Replace all steps
  if (steps && Array.isArray(steps)) {
    db.data.sequence_steps = db.data.sequence_steps.filter(s => s.sequence_id !== seqId);
    steps.forEach((step, index) => {
      db.data.sequence_steps.push({
        id: db.data.sequence_steps.length + 1,
        sequence_id: seqId,
        step_number: index + 1,
        delay_days: step.delay_days || 0,
        delay_unit: step.delay_unit || 'days',
        subject: step.subject || '',
        email_template: step.email_template || '',
        attachments: step.attachments || [],
        stop_on_reply: step.stop_on_reply !== false
      });
    });
  }

  await db.write();
  const updatedSteps = db.data.sequence_steps
    .filter(s => s.sequence_id === seqId)
    .sort((a, b) => a.step_number - b.step_number);
  res.json({ sequence, steps: updatedSteps });
});

// Enroll leads into a sequence (send step 1 emails)
app.post('/api/sequences/:id/enroll', authenticate, async (req, res) => {
  await db.read();
  const seqId = parseInt(req.params.id);
  const sequence = db.data.sequences.find(s => s.id === seqId);

  if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
  if (sequence.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  // Re-enable sequence if it was previously disabled — enrolling new leads means user wants it running
  if (!sequence.is_active) sequence.is_active = true;

  const { lead_ids } = req.body;
  if (!lead_ids || lead_ids.length === 0) return res.status(400).json({ error: 'No leads selected' });

  // ── Plan check: active lead limit ──────────────────────────────────────────
  const user = db.data.users.find(u => u.id === req.userId);
  if (!isPlanActive(user)) {
    return res.status(402).json({
      error: 'plan_expired',
      message: 'Your free trial has expired. Please upgrade to continue.',
      upgrade_url: '/billing'
    });
  }
  const { limits } = getUserPlan(user);
  const currentActiveLeads = db.data.leads.filter(l =>
    l.user_id === req.userId &&
    l.enrolled_sequence_id &&
    !l.sequence_completed &&
    l.status !== 'dead'
  ).length;
  if (limits.active_leads_limit !== null && currentActiveLeads + lead_ids.length > limits.active_leads_limit) {
    return res.status(402).json({
      error: 'lead_limit_reached',
      message: `Your ${limits.name || 'current'} plan allows ${limits.active_leads_limit} active leads. You have ${currentActiveLeads} active leads. Upgrade to enroll more.`,
      current: currentActiveLeads,
      limit: limits.active_leads_limit,
      upgrade_url: '/billing'
    });
  }
  // ───────────────────────────────────────────────────────────────────────────

  const steps = db.data.sequence_steps
    .filter(s => s.sequence_id === seqId)
    .sort((a, b) => a.step_number - b.step_number);

  if (steps.length === 0) return res.status(400).json({ error: 'Sequence has no steps' });

  const step1 = steps[0];
  const leads = db.data.leads.filter(l => l.user_id === req.userId && lead_ids.includes(l.id));

  if (leads.length === 0) return res.status(400).json({ error: 'No valid leads found' });

  const replaceVars = (text, lead) => text
    .replace(/\{\{first_name\}\}/g, lead.first_name || '')
    .replace(/\{\{last_name\}\}/g, lead.last_name || '')
    .replace(/\{\{company\}\}/g, lead.company || '')
    .replace(/\{\{email\}\}/g, lead.email || '')
    .replace(/\{\{phone\}\}/g, lead.phone || '');

  const settings = db.data.email_settings ? db.data.email_settings.find(s => s.user_id === req.userId) : null;
  const results = { success: [], failed: [] };

  // Determine if step 1 should be sent immediately or delayed
  const step1Delay = step1.delay_days || 0;
  const step1Unit = step1.delay_unit || 'days';
  const step1HasDelay = step1Delay > 0;

  for (const lead of leads) {
    try {
      const leadIndex = db.data.leads.findIndex(l => l.id === lead.id);

      if (!step1HasDelay) {
        // No delay on step 1 — send immediately
        const personalizedSubject = replaceVars(step1.subject || sequence.name, lead);
        const personalizedHtml = replaceVars(step1.email_template, lead);

        let emailResult = null;
        if (settings && settings.provider === 'gmail') {
          emailResult = await sendEmail(settings, lead.email, personalizedSubject, personalizedHtml, null, {
            attachments: step1.attachments || [],
            lead_id: lead.id
          });
        }

        // Record the interaction
        if (!db.data.email_interactions) db.data.email_interactions = [];
        db.data.email_interactions.push({
          id: db.data.email_interactions.length + 1,
          lead_id: lead.id,
          sequence_id: seqId,
          step_number: 1,
          direction: 'sent',
          subject: personalizedSubject,
          body: personalizedHtml,
          message_id: emailResult?.threading_message_id || null,
          sent_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        });

        // Track sequence state — step 1 already sent, next is step at index 1
        if (leadIndex !== -1) {
          db.data.leads[leadIndex].enrolled_sequence_id = seqId;
          db.data.leads[leadIndex].sequence_current_step = 1; // step 1 sent, next is index 1
          db.data.leads[leadIndex].sequence_last_sent = new Date().toISOString();
          db.data.leads[leadIndex].last_email_sent_date = new Date().toISOString(); // keep in sync for processFollowUps
          db.data.leads[leadIndex].sequence_completed = steps.length <= 1;
          db.data.leads[leadIndex].sequence_total_steps = steps.length;
        }
      } else {
        // Step 1 has a delay — enroll the lead and let the scheduler send step 1 after the delay
        // e.g. delay_days=3, delay_unit='minutes' means send step 1 in 3 minutes
        if (leadIndex !== -1) {
          db.data.leads[leadIndex].enrolled_sequence_id = seqId;
          db.data.leads[leadIndex].sequence_current_step = 0; // step 1 not yet sent, scheduler will handle it
          db.data.leads[leadIndex].sequence_last_sent = new Date().toISOString(); // enrollment time = start of delay countdown
          db.data.leads[leadIndex].sequence_completed = false;
          db.data.leads[leadIndex].sequence_total_steps = steps.length;
        }
        console.log(`⏳ Lead ${lead.email} enrolled in sequence — step 1 will be sent in ${step1Delay} ${step1Unit}`);
      }

      results.success.push({ email: lead.email, name: `${lead.first_name} ${lead.last_name}` });
    } catch (err) {
      results.failed.push({ email: lead.email, error: err.message });
    }
  }

  // After enrolling all leads, check if every enrolled lead has already completed
  // (happens for 1-step sequences where step 1 is sent immediately with no delay)
  const allEnrolledLeads = db.data.leads.filter(l => l.enrolled_sequence_id === seqId);
  const allCompleted = allEnrolledLeads.length > 0 && allEnrolledLeads.every(l => l.sequence_completed === true);
  if (allCompleted) {
    const seqIdx = db.data.sequences.findIndex(s => s.id === seqId);
    if (seqIdx !== -1 && db.data.sequences[seqIdx].is_active) {
      db.data.sequences[seqIdx].is_active = false;
      console.log(`🔒 All leads completed sequence "${db.data.sequences[seqIdx].name}" — auto-deactivated after enrollment`);
    }
  }

  await db.write();
  res.json({
    message: `Enrolled ${results.success.length} lead(s) into sequence`,
    results
  });
});

// Delete sequence
app.delete('/api/sequences/:id', authenticate, async (req, res) => {
  await db.read();
  const sequence = db.data.sequences.find(s => s.id === parseInt(req.params.id));

  if (!sequence) {
    return res.status(404).json({ error: 'Sequence not found' });
  }

  if (sequence.user_id !== req.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Delete sequence and its steps
  db.data.sequences = db.data.sequences.filter(s => s.id !== parseInt(req.params.id));
  db.data.sequence_steps = db.data.sequence_steps.filter(s => s.sequence_id !== parseInt(req.params.id));

  await db.write();
  res.json({ message: 'Sequence deleted successfully' });
});

app.get('/api/analytics/dashboard', authenticate, async (req, res) => {
  await db.read();
  const days = parseInt(req.query.days) || 30;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const allUserLeads = db.data.leads.filter(l => l.user_id === req.userId);
  const userLeads = allUserLeads.filter(l => {
    if (!l.created_at) return true;
    return new Date(l.created_at) >= cutoffDate;
  });
  const userSequences = db.data.sequences.filter(s => s.user_id === req.userId);

  const totalLeads = userLeads.length;
  const repliesReceived = userLeads.filter(l => l.last_reply_date).length;
  const replyRate = totalLeads > 0 ? Math.round((repliesReceived / totalLeads) * 100) : 0;

  const funnel = {};
  userLeads.forEach(lead => {
    funnel[lead.status] = (funnel[lead.status] || 0) + 1;
  });

  const intentDistribution = { INTERESTED: 0, NOT_NOW: 0, OBJECTION: 0, GHOSTING: 0, DEAD: 0 };
  userLeads.forEach(lead => {
    if (lead.ai_intent && intentDistribution[lead.ai_intent] !== undefined) {
      intentDistribution[lead.ai_intent]++;
    }
  });

  const hotLeads = userLeads.filter(l => l.ai_intent === 'INTERESTED');

  // Recovered this month = INTERESTED leads updated this calendar month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const recoveredThisMonth = allUserLeads.filter(l =>
    l.ai_intent === 'INTERESTED' && l.updated_at && new Date(l.updated_at) >= monthStart
  ).length;

  // Avg time to reply (lead reply date - draft sent date)
  const sentDrafts = db.data.ai_drafts.filter(d => d.user_id === req.userId && d.status === 'sent' && d.sent_at);
  let avgTimeToReplyHours = null;
  if (sentDrafts.length > 0) {
    let totalHours = 0;
    let count = 0;
    for (const d of sentDrafts) {
      const lead = db.data.leads.find(l => l.id === d.lead_id);
      if (lead && lead.last_reply_date) {
        const hours = Math.abs(new Date(lead.last_reply_date) - new Date(d.sent_at)) / (1000 * 60 * 60);
        totalHours += hours;
        count++;
      }
    }
    avgTimeToReplyHours = count > 0 ? Math.round((totalHours / count) * 10) / 10 : null;
  }

  // Manual vs AI Mode comparison
  //
  // Manual = user wrote and sent the email themselves
  //   source: email_history where email_type === 'initial'
  //
  // AI = system-generated emails (sequences + auto follow-ups + auto-replies)
  //   source: email_interactions where sequence_id is set and direction === 'sent'  (sequence steps)
  //         + email_history where email_type === 'follow_up'                        (processFollowUps auto-sends)
  //         + ai_drafts where status === 'sent'                                     (AI reply drafts)
  //
  // Root cause of 100% bug:
  //   Sequence emails are written to email_interactions (not email_history or ai_drafts).
  //   The old code never read email_interactions, so sequence-contacted leads were completely
  //   invisible to the mode comparison. If only 1 lead appeared in a bucket and they replied,
  //   the denominator was 1 and the rate became 100% even though other leads were contacted
  //   via sequences and hadn't replied.

  const manualEmailRecords = (db.data.email_history || []).filter(h =>
    h.user_id === req.userId && h.email_type === 'initial'
  );
  const aiDraftsSent = (db.data.ai_drafts || []).filter(d =>
    d.user_id === req.userId && d.status === 'sent' && d.sent_at
  );
  const aiFollowUpRecords = (db.data.email_history || []).filter(h =>
    h.user_id === req.userId && h.email_type === 'follow_up'
  );
  // Sequence step emails — automated sends, belong in AI bucket.
  // These are stored in email_interactions (not email_history), which is why
  // they were previously invisible and caused the inflated 100% reply rate.
  const userSequenceIds = userSequences.map(s => s.id);
  const sequenceSentRecords = (db.data.email_interactions || []).filter(i =>
    i.sequence_id != null &&
    userSequenceIds.includes(i.sequence_id) &&
    i.direction === 'sent'
  );

  const manualSentCount = manualEmailRecords.length;
  const aiSentCount = aiDraftsSent.length + aiFollowUpRecords.length + sequenceSentRecords.length;

  const manualLeadIds = [...new Set(manualEmailRecords.map(e => e.lead_id))];
  const aiLeadIds = [...new Set([
    ...aiDraftsSent.map(d => d.lead_id),
    ...aiFollowUpRecords.map(h => h.lead_id),
    ...sequenceSentRecords.map(i => i.lead_id)
  ])];

  // Returns the timestamp (ms) of the most recently sent record for a given lead
  // from a list of records that each have a lead_id and sent_at field.
  const latestSentMs = (records, lid) => {
    let max = 0;
    for (const r of records) {
      if (r.lead_id === lid && r.sent_at) {
        const t = new Date(r.sent_at).getTime();
        if (t > max) max = t;
      }
    }
    return max;
  };

  // A lead is counted as "replied to mode X" only if their last_reply_date
  // is AFTER the most recent email sent to them in mode X.
  const manualReplied = manualLeadIds.filter(lid => {
    const lead = allUserLeads.find(l => l.id === lid);
    if (!lead || !lead.last_reply_date) return false;
    const latest = latestSentMs(manualEmailRecords, lid);
    return latest > 0 && new Date(lead.last_reply_date).getTime() > latest;
  }).length;

  const aiReplied = aiLeadIds.filter(lid => {
    const lead = allUserLeads.find(l => l.id === lid);
    if (!lead || !lead.last_reply_date) return false;
    const latest = Math.max(
      latestSentMs(aiDraftsSent, lid),
      latestSentMs(aiFollowUpRecords, lid),
      latestSentMs(sequenceSentRecords, lid)
    );
    return latest > 0 && new Date(lead.last_reply_date).getTime() > latest;
  }).length;

  // INTERESTED means the lead replied with positive intent — same date-check logic applies.
  const manualInterested = manualLeadIds.filter(lid => {
    const lead = allUserLeads.find(l => l.id === lid);
    if (!lead || lead.ai_intent !== 'INTERESTED' || !lead.last_reply_date) return false;
    const latest = latestSentMs(manualEmailRecords, lid);
    return latest > 0 && new Date(lead.last_reply_date).getTime() > latest;
  }).length;

  const aiInterested = aiLeadIds.filter(lid => {
    const lead = allUserLeads.find(l => l.id === lid);
    if (!lead || lead.ai_intent !== 'INTERESTED' || !lead.last_reply_date) return false;
    const latest = Math.max(
      latestSentMs(aiDraftsSent, lid),
      latestSentMs(aiFollowUpRecords, lid),
      latestSentMs(sequenceSentRecords, lid)
    );
    return latest > 0 && new Date(lead.last_reply_date).getTime() > latest;
  }).length;

  const modeComparison = {
    manual: {
      sent: manualSentCount,
      leads_contacted: manualLeadIds.length,
      replies: manualReplied,
      reply_rate: manualLeadIds.length > 0 ? Math.round((manualReplied / manualLeadIds.length) * 100) : 0,
      interested: manualInterested,
      conversion_rate: manualLeadIds.length > 0 ? Math.round((manualInterested / manualLeadIds.length) * 100) : 0
    },
    ai: {
      sent: aiSentCount,
      leads_contacted: aiLeadIds.length,
      replies: aiReplied,
      reply_rate: aiLeadIds.length > 0 ? Math.round((aiReplied / aiLeadIds.length) * 100) : 0,
      interested: aiInterested,
      conversion_rate: aiLeadIds.length > 0 ? Math.round((aiInterested / aiLeadIds.length) * 100) : 0
    }
  };

  // Sequence step performance — computed from email_interactions (the real sent log)
  const sequenceSteps = (db.data.sequence_steps || [])
    .filter(s => userSequenceIds.includes(s.sequence_id))
    .sort((a, b) => a.sequence_id - b.sequence_id || a.step_number - b.step_number);

  // All outbound sequence interactions for this user's sequences
  const allSeqInteractions = (db.data.email_interactions || []).filter(i =>
    i.sequence_id != null && userSequenceIds.includes(i.sequence_id) && i.direction === 'sent'
  );

  const sequences = sequenceSteps.map(step => {
    const stepNum = step.step_number;
    const seqId = step.sequence_id;

    // All sent records for this specific step
    const stepSentInteractions = allSeqInteractions.filter(i =>
      i.sequence_id === seqId && i.step_number === stepNum
    );
    const sentCount = stepSentInteractions.length;

    // Leads that received this step — check if they replied at any point after enrollment
    const leadIdsSentThisStep = new Set(stepSentInteractions.map(i => i.lead_id));
    const repliesCount = allUserLeads.filter(l =>
      leadIdsSentThisStep.has(l.id) && !!l.last_reply_date
    ).length;

    return {
      step: stepNum,
      sequence_id: seqId,
      sequence_name: userSequences.find(s => s.id === seqId)?.name || `Sequence ${seqId}`,
      name: step.subject || `Step ${stepNum}`,
      sent: sentCount,
      opens: 0,   // no open-tracking pixel implemented
      clicks: 0,  // no click-tracking implemented
      replies: repliesCount
    };
  });

  // Daily reply rate trend (last 7 days)
  const replyRateTrend = [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const dayLeads = allUserLeads.filter(l => {
      if (!l.created_at) return false;
      const created = new Date(l.created_at);
      return created >= dayStart && created < dayEnd;
    });
    const dayReplies = dayLeads.filter(l => l.last_reply_date).length;
    const rate = dayLeads.length > 0 ? Math.round((dayReplies / dayLeads.length) * 100) : 0;
    replyRateTrend.push({ day: dayNames[date.getDay()], rate });
  }

  const upcomingAppointments = (db.data.appointments || [])
    .filter(a => a.user_id === req.userId && a.status === 'scheduled')
    .map(apt => {
      const lead = db.data.leads.find(l => l.id === apt.lead_id);
      return {
        ...apt,
        lead: lead
          ? { id: lead.id, first_name: lead.first_name, last_name: lead.last_name, email: lead.email, company: lead.company }
          : null
      };
    })
    .sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));

  res.json({
    overview: {
      total_leads: totalLeads,
      reply_rate: replyRate,
      recovered_this_month: recoveredThisMonth,
      active_sequences: userSequences.filter(s => s.is_active).length,
      avg_time_to_reply_hours: avgTimeToReplyHours
    },
    hot_leads: hotLeads,
    upcoming_appointments: upcomingAppointments,
    funnel,
    intent_distribution: intentDistribution,
    mode_comparison: modeComparison,
    sequences,
    reply_rate_trend: replyRateTrend
  });
});

// Email Tracking - Track Opens
app.get('/api/track/open/:leadId/:campaignId', async (req, res) => {
  const { leadId, campaignId } = req.params;
  await db.read();
  
  db.data.email_events.push({
    id: db.data.email_events.length + 1,
    lead_id: parseInt(leadId),
    campaign_id: parseInt(campaignId),
    event_type: 'open',
    timestamp: new Date().toISOString()
  });
  
  await db.write();
  
  // Return 1x1 transparent pixel
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length
  });
  res.end(pixel);
});

// Email Tracking - Track Clicks
app.get('/api/track/click/:leadId/:campaignId', async (req, res) => {
  const { leadId, campaignId } = req.params;
  const { url } = req.query;
  
  await db.read();
  
  db.data.email_events.push({
    id: db.data.email_events.length + 1,
    lead_id: parseInt(leadId),
    campaign_id: parseInt(campaignId),
    event_type: 'click',
    url: url,
    timestamp: new Date().toISOString()
  });
  
  await db.write();
  
  // Redirect to actual URL
  res.redirect(url || 'https://example.com');
});

// Create Campaign
app.post('/api/campaigns', authenticate, async (req, res) => {
  const { name, subject, body, sequence_id } = req.body;
  await db.read();
  
  const campaign = {
    id: db.data.campaigns.length + 1,
    user_id: req.userId,
    name,
    subject,
    body,
    sequence_id: sequence_id || null,
    status: 'active',
    created_at: new Date().toISOString(),
    stats: {
      sent: 0,
      opens: 0,
      clicks: 0,
      replies: 0,
      bounces: 0
    }
  };
  
  db.data.campaigns.push(campaign);
  await db.write();
  
  res.json({ campaign });
});

// Get Campaign Analytics
app.get('/api/campaigns/:id/analytics', authenticate, async (req, res) => {
  await db.read();
  
  const campaign = db.data.campaigns.find(c => 
    c.id === parseInt(req.params.id) && c.user_id === req.userId
  );
  
  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  
  const events = db.data.email_events.filter(e => e.campaign_id === campaign.id);
  
  const uniqueOpens = new Set(events.filter(e => e.event_type === 'open').map(e => e.lead_id)).size;
  const uniqueClicks = new Set(events.filter(e => e.event_type === 'click').map(e => e.lead_id)).size;
  
  const analytics = {
    campaign: campaign.name,
    sent: campaign.stats.sent,
    opens: uniqueOpens,
    clicks: uniqueClicks,
    replies: campaign.stats.replies,
    bounces: campaign.stats.bounces,
    open_rate: campaign.stats.sent > 0 ? Math.round((uniqueOpens / campaign.stats.sent) * 100) : 0,
    click_rate: campaign.stats.sent > 0 ? Math.round((uniqueClicks / campaign.stats.sent) * 100) : 0,
    reply_rate: campaign.stats.sent > 0 ? Math.round((campaign.stats.replies / campaign.stats.sent) * 100) : 0
  };
  
  res.json(analytics);
});

// Get All Campaigns
app.get('/api/campaigns', authenticate, async (req, res) => {
  await db.read();
  
  const userCampaigns = db.data.campaigns.filter(c => c.user_id === req.userId);
  
  const campaignsWithStats = userCampaigns.map(campaign => {
    const events = db.data.email_events.filter(e => e.campaign_id === campaign.id);
    const uniqueOpens = new Set(events.filter(e => e.event_type === 'open').map(e => e.lead_id)).size;
    const uniqueClicks = new Set(events.filter(e => e.event_type === 'click').map(e => e.lead_id)).size;
    
    return {
      ...campaign,
      stats: {
        ...campaign.stats,
        opens: uniqueOpens,
        clicks: uniqueClicks
      }
    };
  });
  
  res.json({ campaigns: campaignsWithStats });
});

// Track Lead Source
app.post('/api/leads/:id/source', authenticate, async (req, res) => {
  const { source, campaign_id, cost } = req.body;
  await db.read();
  
  const lead = db.data.leads.find(l => 
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );
  
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }
  
  db.data.lead_sources.push({
    id: db.data.lead_sources.length + 1,
    lead_id: lead.id,
    source: source, // 'linkedin', 'website', 'referral', etc.
    campaign_id: campaign_id || null,
    cost: cost || 0,
    created_at: new Date().toISOString()
  });
  
  await db.write();
  
  res.json({ success: true });
});

// Generate Initial Email with AI
app.post('/api/leads/:id/generate-initial-email', authenticate, async (req, res) => {
  await db.read();

  const lead = db.data.leads.find(l =>
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  // ── Plan + AI generation limit check ──────────────────────────────────────
  const userForCheck = db.data.users.find(u => u.id === req.userId);
  if (!isPlanActive(userForCheck)) {
    return res.status(402).json({ error: 'plan_expired', message: 'Your free trial has expired. Please upgrade to continue.', upgrade_url: '/billing' });
  }
  await resetMonthlyCounterIfNeeded(userForCheck);
  const { limits: genLimits } = getUserPlan(userForCheck);
  if ((userForCheck.ai_generations_this_month || 0) >= genLimits.ai_generations_limit) {
    return res.status(402).json({ error: 'ai_limit_reached', message: `You've used all ${genLimits.ai_generations_limit} AI generations for this month. Upgrade your plan for more.`, upgrade_url: '/billing' });
  }
  // ───────────────────────────────────────────────────────────────────────────

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'demo-mode') {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add your API key in backend .env for AI email generation.' });
  }

  try {
    // Get product profile for context
    const productProfile = db.data.product_profiles.find(p => p.user_id === req.userId);
    const sellerProfile = db.data.seller_profiles.find(p => p.user_id === req.userId);
    const userRecord = db.data.users.find(u => u.id === req.userId);

    // Build product context for AI
    let productContext = '';
    if (productProfile) {
      productContext = `

YOUR PRODUCT/SERVICE INFORMATION (for benefits and features ONLY — do NOT use any contact details from this section):
- Product: ${productProfile.product_name || 'Your Product'}
- Description: ${productProfile.product_description || 'A valuable solution'}
- Key Benefits: ${productProfile.key_benefits || 'Helps solve important problems'}
- Target Audience: ${productProfile.target_audience || 'Businesses like theirs'}
- Pain Points We Solve: ${productProfile.pain_points || 'Common challenges'}
- Unique Selling Points: ${productProfile.unique_selling_points || 'What makes us different'}
${productProfile.success_stories ? `- Success Stories: ${productProfile.success_stories}` : ''}
${productProfile.special_offers ? `- Special Offer: ${productProfile.special_offers}` : ''}
- Call-to-Action: ${productProfile.call_to_action || 'Schedule a quick call to learn more'}`;
    }

    const sellerContext = getSellerContext(sellerProfile);
    const businessTypeContext = getBusinessTypeContext(userRecord?.business_type || 'other');
    const businessKnowledgeContext = getBusinessKnowledgeContext(userRecord?.business_knowledge || '', userRecord?.live_updates || '');
    const customInstructionsContext = getCustomInstructionsContext(userRecord?.ai_custom_instructions || '');

    // Generate initial email content using AI
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Write a professional, persuasive initial outreach email to a potential lead. Keep it under 100 words.

Lead details:
- Name: ${lead.first_name} ${lead.last_name}
- Company: ${lead.company || 'their company'}
- Email: ${lead.email}
${productContext}${sellerContext}${businessTypeContext ? '\n\n' + businessTypeContext : ''}${businessKnowledgeContext ? '\n\n' + businessKnowledgeContext : ''}${customInstructionsContext ? '\n\n' + customInstructionsContext : ''}${SELLER_GUARDRAIL}

Write a compelling email that:
1. Introduces yourself and your product briefly
2. Mentions a specific pain point they likely face
3. Explains how your product solves that problem (with key benefit)
4. Includes a clear call-to-action
5. Is personalized and doesn't feel like spam
6. Sounds natural and conversational

IMPORTANT: Output ONLY the email body text. Do NOT include a subject line, do NOT write "Subject:", do NOT add headers of any kind. Start directly with the greeting (e.g. "Hi John,").

Email body:`
        }]
      })
    });

    if (!response.ok) {
      throw new Error('AI email generation failed');
    }

    const aiData = await response.json();
    const emailBody = aiData.content[0].text.trim();

    // Increment AI generation counter
    const uIdx = db.data.users.findIndex(u => u.id === req.userId);
    if (uIdx !== -1) {
      db.data.users[uIdx].ai_generations_this_month = (db.data.users[uIdx].ai_generations_this_month || 0) + 1;
      await db.write();
    }

    res.json({ email_body: emailBody });
  } catch (error) {
    console.error('AI generation error:', error);
    res.status(500).json({ error: 'Failed to generate email with AI' });
  }
});

// Generate Email Content (Guided Template - only middle sections)
app.post('/api/leads/:id/generate-email-content', authenticate, async (req, res) => {
  await db.read();

  const lead = db.data.leads.find(l =>
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  // ── Plan + AI generation limit check ──────────────────────────────────────
  const userForGenCheck = db.data.users.find(u => u.id === req.userId);
  if (!isPlanActive(userForGenCheck)) {
    return res.status(402).json({ error: 'plan_expired', message: 'Your free trial has expired. Please upgrade to continue.', upgrade_url: '/billing' });
  }
  await resetMonthlyCounterIfNeeded(userForGenCheck);
  const { limits: genLimits2 } = getUserPlan(userForGenCheck);
  if ((userForGenCheck.ai_generations_this_month || 0) >= genLimits2.ai_generations_limit) {
    return res.status(402).json({ error: 'ai_limit_reached', message: `You've used all ${genLimits2.ai_generations_limit} AI generations for this month. Upgrade your plan for more.`, upgrade_url: '/billing' });
  }
  // ───────────────────────────────────────────────────────────────────────────

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'demo-mode') {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add your API key in backend .env for AI email generation.' });
  }

  try {
    // Get product and seller profiles for context
    const productProfile = db.data.product_profiles.find(p => p.user_id === req.userId);
    const sellerProfile = db.data.seller_profiles.find(p => p.user_id === req.userId);

    // Build product context for AI
    let productContext = '';
    if (productProfile) {
      productContext = `

YOUR PRODUCT/SERVICE INFORMATION (for benefits and features ONLY — do NOT use any contact details from this section):
- Product: ${productProfile.product_name || 'Your Product'}
- Description: ${productProfile.product_description || 'A valuable solution'}
- Key Benefits: ${productProfile.key_benefits || 'Helps solve important problems'}
- Target Audience: ${productProfile.target_audience || 'Businesses like theirs'}
- Pain Points We Solve: ${productProfile.pain_points || 'Common challenges'}
- Unique Selling Points: ${productProfile.unique_selling_points || 'What makes us different'}
${productProfile.success_stories ? `- Success Stories: ${productProfile.success_stories}` : ''}
${productProfile.special_offers ? `- Special Offer: ${productProfile.special_offers}` : ''}
- Call-to-Action: ${productProfile.call_to_action || 'Schedule a quick call to learn more'}`;
    }

    const sellerContext = getSellerContext(sellerProfile);

    // Generate only the middle content (context, main message, CTA) using AI
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Generate ONLY the middle content sections for an email to a potential lead. Return EXACTLY three sections separated by "---":

Lead details:
- Name: ${lead.first_name} ${lead.last_name}
- Company: ${lead.company || 'their company'}
- Email: ${lead.email}
${productContext}${sellerContext}${SELLER_GUARDRAIL}

Generate these three sections:

1. CONTEXT (1-2 sentences): Why you're reaching out and what caught your attention about their company
2. MAIN MESSAGE (3-4 sentences): Explain your product/service, key benefits, and how it solves their pain points. Include relevant success stories or statistics if available.
3. CALL TO ACTION (1-2 sentences): A clear, specific next step (e.g., schedule a call, request a demo)

Format your response EXACTLY like this (use "---" as separator):

Context section here

---

Main message section here

---

Call to action section here`
        }]
      })
    });

    if (!response.ok) {
      throw new Error('AI content generation failed');
    }

    const aiData = await response.json();
    const fullContent = aiData.content[0].text.trim();

    // Parse the three sections
    const sections = fullContent.split('---').map(s => s.trim());

    // Increment AI generation counter
    const uIdx2 = db.data.users.findIndex(u => u.id === req.userId);
    if (uIdx2 !== -1) {
      db.data.users[uIdx2].ai_generations_this_month = (db.data.users[uIdx2].ai_generations_this_month || 0) + 1;
      await db.write();
    }

    res.json({
      context: sections[0] || '',
      main_message: sections[1] || '',
      call_to_action: sections[2] || ''
    });
  } catch (error) {
    console.error('AI content generation error:', error);
    res.status(500).json({ error: 'Failed to generate email content with AI' });
  }
});

// Polish/Enhance Email Content with AI
app.post('/api/leads/:id/polish-email', authenticate, async (req, res) => {
  await db.read();

  const lead = db.data.leads.find(l =>
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const userForCheck = db.data.users.find(u => u.id === req.userId);
  if (!isPlanActive(userForCheck)) {
    return res.status(402).json({ error: 'plan_expired', message: 'Your free trial has expired. Please upgrade to continue.', upgrade_url: '/billing' });
  }
  await resetMonthlyCounterIfNeeded(userForCheck);
  const { limits: genLimits } = getUserPlan(userForCheck);
  if ((userForCheck.ai_generations_this_month || 0) >= genLimits.ai_generations_limit) {
    return res.status(402).json({ error: 'ai_limit_reached', message: `You've used all ${genLimits.ai_generations_limit} AI generations for this month. Upgrade your plan for more.`, upgrade_url: '/billing' });
  }

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'demo-mode') {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set.' });
  }

  const { content, field_type } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Load seller profile so AI can sign off with real name instead of placeholders
  const sellerProfile = db.data.seller_profiles.find(p => p.user_id === req.userId);
  const senderName = sellerProfile?.name || '';
  const senderTitle = sellerProfile?.title || '';
  const senderCompany = sellerProfile?.company || '';
  const signoffLine = senderName
    ? `${senderName}${senderTitle ? ', ' + senderTitle : ''}${senderCompany ? '\n' + senderCompany : ''}`
    : null;

  const senderRule = signoffLine
    ? `SENDER INFO (use this for the sign-off — do NOT use placeholders like [Your Name]):\n${signoffLine}\n\n`
    : `Do NOT use placeholder text like [Your Name] or [Your Contact Information] — if you don't know the sender's name, sign off with just "Best regards" and nothing else.\n\n`;

  const leadName = lead.first_name || 'there';

  let prompt;
  if (field_type === 'context') {
    prompt = `Polish this email opening/context section to be more compelling and concise. Keep the exact same intent. Output only the polished text, no labels or quotes:\n\n${content}`;
  } else if (field_type === 'main_message') {
    prompt = `Polish this email main message to be more persuasive, clear, and professional. Keep the same ideas and roughly the same length. Output only the polished text, no labels or quotes:\n\n${content}`;
  } else if (field_type === 'call_to_action') {
    prompt = `Polish this email call-to-action to be clearer and more compelling. Keep the same intent. Output only the polished text, no labels or quotes:\n\n${content}`;
  } else if (field_type === 'subject') {
    prompt = `Polish this email subject line. Rules: under 50 characters, sentence case (only first word capitalised), specific and direct, no spam words (FREE/URGENT/LIMITED etc.), no exclamation marks, no "Re:" or "Fwd:". Output ONLY the subject text — no quotes, no "Subject:" prefix.\n\nSubject to polish:\n${content}`;
  } else if (field_type === 'subject_generate') {
    prompt = `Write a subject line for this email. Rules: under 50 characters, sentence case (only first word capitalised), specific and relevant to the content, no spam words (FREE/URGENT/LIMITED etc.), no exclamation marks. Output ONLY the subject text — no quotes, no "Subject:" prefix.\n\nEmail body:\n${content}`;
  } else {
    prompt = `${senderRule}Rewrite these notes or draft into a short, natural outreach email. You are the agent/seller presenting this — write from that perspective (e.g. "I have a property…", "We have a listing…"). The recipient is ${leadName}${lead.company ? ' at ' + lead.company : ''}.\n\nStrict rules:\n- Greeting: "Hi ${leadName}," — never "Dear [Name]"\n- Body: 2–4 sentences MAX — get to the point immediately\n- Write as the agent/seller — never use discovery language like "I came across" or "I noticed"\n- No filler openers ("I hope this finds you well", "I wanted to reach out", etc.)\n- Conversational tone, not stiff corporate language\n- No padding or repetition\n- Output ONLY the email body — no subject line, no "Subject:" label\n- Start directly with the greeting\n\nNotes/draft to turn into an email:\n${content}`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: (field_type === 'subject' || field_type === 'subject_generate') ? 50 : 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) throw new Error('AI polish failed');

    const aiData = await response.json();
    const polishedContent = aiData.content[0].text.trim();

    const uIdx = db.data.users.findIndex(u => u.id === req.userId);
    if (uIdx !== -1) {
      db.data.users[uIdx].ai_generations_this_month = (db.data.users[uIdx].ai_generations_this_month || 0) + 1;
      await db.write();
    }

    res.json({ polished_content: polishedContent });
  } catch (error) {
    console.error('AI polish error:', error);
    res.status(500).json({ error: 'Failed to polish content with AI' });
  }
});

// Send Initial Email to Lead
app.post('/api/leads/:id/send-initial-email', authenticate, async (req, res) => {
  const { email_body, subject, html_body, attachments } = req.body;

  if (!email_body) {
    return res.status(400).json({ error: 'Email body is required' });
  }

  // Validate total attachment size (25MB limit for Gmail)
  if (attachments && attachments.length > 0) {
    const totalSize = attachments.reduce((sum, att) => sum + (att.size || 0), 0);
    const maxSize = 25 * 1024 * 1024; // 25MB (Gmail limit)
    if (totalSize > maxSize) {
      return res.status(400).json({
        error: `Total attachment size (${(totalSize / 1024 / 1024).toFixed(2)}MB) exceeds 25MB Gmail limit`
      });
    }
  }

  await db.read();

  const lead = db.data.leads.find(l =>
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );

  const settings = db.data.email_settings.find(s => s.user_id === req.userId);
  const user = db.data.users.find(u => u.id === req.userId);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  if (!settings || !settings.email) {
    return res.status(400).json({ error: 'Email settings not configured. Please set your email in Settings.' });
  }

  try {
    // Send the email
    const emailSubject = subject || `Quick question about ${lead.company || 'your business'}`;
    const senderName = `${user.company_name || 'Your Team'}`;

    // Call sendEmail with HTML and attachments support
    await sendEmail(settings, lead.email, emailSubject, email_body, senderName, {
      html: html_body,
      attachments: attachments || [],
      lead_id: lead.id
    });

    // Update lead with email tracking info
    lead.initial_email_sent = true;
    lead.initial_email_sent_date = new Date().toISOString();
    lead.email_count = (lead.email_count || 0) + 1;
    lead.last_email_sent_date = new Date().toISOString();
    lead.status = 'contacted';
    lead.ai_paused_by_human = false; // AI continues to follow up even after manual send
    lead.last_email_sender = 'human';
    lead.clarification_count = 0; // Human sent email — reset clarification counter

    // Dismiss any pending or sent AI drafts for this lead — human replied manually, no further action needed
    if (db.data.ai_drafts) {
      db.data.ai_drafts
        .filter(d => d.lead_id === lead.id && d.user_id === req.userId && (d.status === 'pending' || d.status === 'sent'))
        .forEach(d => {
          if (d.status === 'pending') {
            d.status = 'rejected';
            d.rejected_reason = 'human_manual_reply';
            d.rejected_at = new Date().toISOString();
          } else if (d.status === 'sent') {
            // Mark sent drafts as superseded by manual reply
            d.superseded_by_manual = true;
            d.superseded_at = new Date().toISOString();
          }
        });
    }

    // Store email in history with new fields
    db.data.email_history.push({
      id: db.data.email_history.length + 1,
      lead_id: lead.id,
      user_id: req.userId,
      email_type: 'initial',
      subject: emailSubject,
      body: email_body,
      html_body: html_body || email_body.replace(/\n/g, '<br>'),
      attachments: attachments ? attachments.map(att => ({
        filename: att.filename,
        size: att.size,
        content_type: att.content_type
      })) : [],
      sent_at: new Date().toISOString(),
      status: 'sent'
    });

    await db.write();

    res.json({ success: true, lead });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: error.message || 'Failed to send email. Check your email settings.' });
  }
});

// AI Reply Analysis
app.post('/api/leads/:id/analyze-reply', authenticate, async (req, res) => {
  const { reply_text, subject = '' } = req.body;

  if (!reply_text) {
    return res.status(400).json({ error: 'Reply text is required' });
  }
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'demo-mode') {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Add your API key in backend .env for AI analysis.' });
  }
  
  await db.read();
  
  const lead = db.data.leads.find(l => 
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );
  
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }
  
  try {
    // Call Claude API for AI analysis
    const analysisResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // HAIKU - Fast & cheap for classification
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Analyze this email and classify the lead's intent. Reply ONLY with one of these exact words: INTERESTED, NOT_NOW, OBJECTION, GHOSTING, or DEAD.

Classification Rules (read carefully):
- INTERESTED: They want to engage — asking questions about the product/property/service, requesting info, asking about location/price/details (e.g., "where is the location?", "what is the price?", "I'm interested", "let's schedule", "can we talk", "how do I get there?", "what is your name?", "tell me more")
- OBJECTION: They raise a concern, hesitation, or problem that can be addressed (e.g., "too expensive", "it's far from my home", "I'm not sure if it fits my needs", "the location is inconvenient", "concerned about the distance", "is it accessible?", "the price seems high")
- NOT_NOW: They explicitly say timing is wrong with clear time-based language (e.g., "not now", "maybe next month", "check back in Q2", "call me after the holidays", "I'm busy until March") — MUST include actual time/timing words
- DEAD: Clear rejection with no interest (e.g., "not interested", "no thanks", "remove me", "stop emailing", "don't contact me")
- GHOSTING: Vague, non-committal responses with no question and no clear meaning (e.g., "thanks", "ok", "noted", "sure") — use only when none of the above apply

IMPORTANT: Distance/location concerns (e.g., "far from home", "inconvenient location", "too far") = OBJECTION, NOT NOT_NOW.
IMPORTANT: Questions about location, price, details, or the business = INTERESTED.
IMPORTANT: If both subject and body are blank = GHOSTING.
IMPORTANT: Use BOTH the subject line and body together — sometimes the subject alone reveals intent.
${subject ? `\nSubject: "${subject}"` : ''}
Email body: "${reply_text}"

Reply with exactly ONE word:`
        }]
      })
    });

    let ai_intent = 'GHOSTING'; // Default - conservative fallback for unclear responses
    let ai_reasoning = '';
    
    if (analysisResponse.ok) {
      const aiData = await analysisResponse.json();
      let raw = aiData.content[0].text.trim().toUpperCase();
      console.log(`[CLAUDE API RESPONSE] Raw: "${raw.substring(0, 150)}"`);
      // Sometimes API returns extra text; take first valid word
      const validIntents = ['INTERESTED', 'NOT_NOW', 'OBJECTION', 'GHOSTING', 'DEAD'];
      const found = validIntents.find(v =>
        raw === v ||
        raw.startsWith(v + ' ') ||
        raw.startsWith(v + '\n') ||
        raw.includes('\n' + v) ||
        raw.includes(': ' + v) ||
        raw.includes(' ' + v + '\n') ||
        raw.includes('\n\n' + v)
      );
      if (found) {
        ai_intent = found;
        console.log(`[CLAUDE API] → ${ai_intent}`);
      } else {
        console.log(`[CLAUDE API] No valid intent found, will use fallback`);
      }
      
      // Get reasoning
      const reasoningResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // HAIKU - Simple explanation task
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: `Based on this reply: "${reply_text}"

Why is this classified as ${ai_intent}? Give a 1-sentence explanation.`
          }]
        })
      });
      
      if (reasoningResponse.ok) {
        const reasoningData = await reasoningResponse.json();
        ai_reasoning = reasoningData.content[0].text.trim();
      }
    }
    
    // Classify objection sub-type if intent is OBJECTION
    let objection_subtype = null;
    if (ai_intent === 'OBJECTION') {
      const subtypeResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // HAIKU - Simple categorization
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: `Classify this objection into ONE category. Reply ONLY with one of these exact words: PRICE, TIMING, FIT_NEEDS, TRUST, or OTHER.

Objection Categories:
- PRICE: Cost, budget, or pricing concerns (e.g., "too expensive", "can't afford", "outside our budget")
- TIMING: Timing or scheduling concerns (e.g., "not the right time", "too busy now", "maybe next quarter")
- FIT_NEEDS: Product/service fit or feature concerns (e.g., "doesn't have X feature", "not sure it fits our needs", "looking for something else")
- TRUST: Trust, credibility, or proof concerns (e.g., "never heard of you", "need references", "prove it works")
- OTHER: Any other objection type

Email reply: "${reply_text}"

Category:`
          }]
        })
      });

      if (subtypeResponse.ok) {
        const subtypeData = await subtypeResponse.json();
        let raw = subtypeData.content[0].text.trim().toUpperCase();
        const validSubtypes = ['PRICE', 'TIMING', 'FIT_NEEDS', 'TRUST', 'OTHER'];
        const found = validSubtypes.find(v => raw === v || raw.startsWith(v + ' ') || raw.includes('\n' + v));
        if (found) objection_subtype = found;
        else if (validSubtypes.includes(raw)) objection_subtype = raw;
        else objection_subtype = 'OTHER';
      }
    }

    // Determine decision recommendation based on intent and context
    let decision_recommendation = 'DRAFT_ONLY'; // Default to safe option

    switch(ai_intent) {
      case 'INTERESTED':
        // Hot leads should be sent quickly, but with human approval for safety
        decision_recommendation = 'AUTO_SEND';
        break;
      case 'NOT_NOW':
        // Wait and follow up later
        decision_recommendation = 'WAIT';
        break;
      case 'OBJECTION':
        // Objections need careful handling - draft only
        decision_recommendation = 'DRAFT_ONLY';
        break;
      case 'GHOSTING':
        // Vague responses - try different approach later
        decision_recommendation = 'WAIT';
        break;
      case 'DEAD':
        // Clear rejection - stop following up
        decision_recommendation = 'STOP';
        break;
    }

    // Update lead with AI analysis
    lead.ai_intent = ai_intent;
    lead.ai_reasoning = ai_reasoning;
    lead.objection_subtype = objection_subtype;
    lead.decision_recommendation = decision_recommendation;
    lead.last_reply = reply_text;
    lead.last_reply_date = new Date().toISOString();
    lead.last_subject = subject || '(No Subject)';
    
    // Generate AI draft for ALL intents — auto-send if in auto mode, else save for manual review
    let draftId = null;
    let auto_sent = false;
    let clarification_needed = false;
    try {
      const aiResult = await generateAIResponse(lead, reply_text, ai_intent, subject);
      if (aiResult) {
        let draftBody = aiResult.body;
        clarification_needed = aiResult.clarification_needed || false;

        // Safety: never send blank emails
        if (!draftBody || !draftBody.trim()) {
          console.log(`⚠️  Empty draft body for lead ${lead.id} (${lead.first_name}) — using holding reply`);
          draftBody = `Hi ${lead.first_name},\n\nThank you for reaching out! That's a great question.\n\nLet me look into this and get back to you with the right information shortly.\n\nBest regards`;
          clarification_needed = true;
        }

        const newDraft = {
          id: db.data.ai_drafts.length + 1,
          lead_id: lead.id,
          user_id: req.userId,
          draft_body: draftBody,
          ai_intent: ai_intent,
          reply_text: reply_text,
          reply_subject: subject || '',
          status: 'pending',
          clarification_needed: clarification_needed,
          created_at: new Date().toISOString()
        };

        db.data.ai_drafts.push(newDraft);
        await db.write();
        draftId = newDraft.id;

        const user = db.data.users.find(u => u.id === req.userId);
        const emailSettings = db.data.email_settings.find(s => s.user_id === req.userId);

        const shouldAutoSend = user && user.auto_mode_enabled && lead.auto_send_enabled !== false;
        const alreadySentHolding = (lead.clarification_count || 0) >= 1;

        if (shouldAutoSend && clarification_needed && alreadySentHolding) {
          // STOP: Already sent holding reply. Save draft for manual follow-up.
          console.log(`🛑 STOPPED auto-reply for ${lead.first_name} — already sent holding reply. Saving draft for manual follow-up.`);
          lead.clarification_count = (lead.clarification_count || 0) + 1;
          newDraft.needs_follow_up = true;
          await db.write();
        } else if (shouldAutoSend && emailSettings) {
          try {
            await sendEmail(emailSettings, lead.email, `Re: ${subject || 'Following up'}`, draftBody, null, {
              lead_id: lead.id
            });
            newDraft.status = 'sent';
            newDraft.sent_at = new Date().toISOString();
            newDraft.final_body = draftBody;
            lead.status = 'replied';
            auto_sent = true;

            if (clarification_needed) {
              lead.clarification_count = (lead.clarification_count || 0) + 1;
              newDraft.needs_follow_up = true;
              console.log(`📋 Holding reply auto-sent to ${lead.first_name} — flagged for your follow-up (question not in knowledge base)`);
            } else {
              lead.clarification_count = 0;
              resolveStaleActionRequiredDrafts(lead.id);
            }
            await db.write();
          } catch (sendError) {
            console.error('Auto-send failed:', sendError);
            // Draft remains in pending state for manual review
          }
        } else if (clarification_needed) {
          console.log(`⚠️  Clarification needed for lead ${lead.id} (${lead.first_name}) — question not in knowledge base. Draft saved for manual reply.`);
        } else {
          // Manual mode, correct draft saved — resolve stale Action Required drafts
          resolveStaleActionRequiredDrafts(lead.id);
          await db.write();
        }
      }
    } catch (e) {
      console.error('Draft generation:', e);
    }
    
    // Status: analyzed = we analyzed their reply; replied = we actually sent a reply to them
    if (ai_intent === 'INTERESTED') {
      lead.status = 'interested';
    } else if (ai_intent === 'DEAD') {
      lead.status = 'dead';
    } else {
      lead.status = 'analyzed';
    }
    
    await db.write();
    
    // Generate recommendation
    let recommendation = '';
    switch(ai_intent) {
      case 'INTERESTED':
        recommendation = '🔥 HOT LEAD! Contact them immediately - they want to buy!';
        break;
      case 'NOT_NOW':
        recommendation = '⏰ Follow up in 2-4 weeks. Set a reminder.';
        break;
      case 'OBJECTION':
        recommendation = '💡 Send case study or testimonial addressing their concern.';
        break;
      case 'GHOSTING':
        recommendation = '👻 Try a different approach - change subject line or angle.';
        break;
      case 'DEAD':
        recommendation = '❌ Move on. Focus energy on better prospects.';
        break;
    }
    
    res.json({
      ai_intent,
      ai_reasoning,
      objection_subtype,
      decision_recommendation,
      recommendation,
      draft_id: draftId,
      auto_sent,
      clarification_needed,
      clarification_alert: clarification_needed
        ? `⚠️ AI could not answer ${lead.first_name}'s question — your Product Knowledge Base is missing required info. Please reply to this customer manually.`
        : null,
      lead: {
        id: lead.id,
        first_name: lead.first_name,
        last_name: lead.last_name,
        status: lead.status
      }
    });
    
  } catch (error) {
    console.error('AI Analysis Error:', error);

    // Fallback: Simple keyword-based analysis
    const lowerReply = reply_text.toLowerCase();
    let ai_intent = 'GHOSTING'; // Conservative default
    let ai_reasoning = 'Analyzed using keyword detection (AI API unavailable)';
    console.log(`[FALLBACK CLASSIFICATION] Input: "${reply_text.substring(0, 100)}"`);
    console.log(`[FALLBACK] Lowercase: "${lowerReply}"`);

    // Check for clear interest signals first (highest priority)
    if (lowerReply.includes('interested') || lowerReply.includes('yes') || lowerReply.includes('sounds good') ||
        lowerReply.includes('schedule') || lowerReply.includes('call me') || lowerReply.includes('let\'s talk') ||
        lowerReply.includes('lets talk') || lowerReply.includes('can we talk') || lowerReply.includes('want to discuss') ||
        lowerReply.includes('where is') || lowerReply.includes('what is the') || lowerReply.includes('how much') ||
        lowerReply.includes('more info') || lowerReply.includes('tell me more') || lowerReply.includes('what are')) {
      ai_intent = 'INTERESTED';
      console.log(`[FALLBACK] → INTERESTED`);
    }
    // Check for clear rejection
    else if (lowerReply.includes('not interested') || lowerReply.includes('no thanks') ||
             lowerReply.includes('stop') || lowerReply.includes('unsubscribe')) {
      ai_intent = 'DEAD';
      console.log(`[FALLBACK] → DEAD`);
    }
    // Check for concerns/objections BEFORE timing (location concerns are more specific)
    else if (lowerReply.includes('but ') || lowerReply.includes('however') ||
             lowerReply.includes('concern') || lowerReply.includes('expensive') ||
             lowerReply.includes('not sure') || lowerReply.includes('far from') ||
             lowerReply.includes('too far') || lowerReply.includes('location') ||
             lowerReply.includes('distance') || lowerReply.includes('inconvenient') ||
             lowerReply.includes('accessible') || lowerReply.includes('price seems')) {
      ai_intent = 'OBJECTION';
      console.log(`[FALLBACK] → OBJECTION`);
    }
    // Check for specific timing delays (after objection check)
    else if ((lowerReply.includes('later') || lowerReply.includes('next month') ||
              lowerReply.includes('next quarter') || lowerReply.includes('not now')) &&
             !lowerReply.includes('interested')) {
      ai_intent = 'NOT_NOW';
      console.log(`[FALLBACK] → NOT_NOW (timing matched)`);
    }
    else {
      console.log(`[FALLBACK] → GHOSTING (no keywords matched)`);
    }
    // Otherwise defaults to GHOSTING (vague/unclear)
    
    // Classify objection sub-type using keywords if intent is OBJECTION
    let objection_subtype = null;
    if (ai_intent === 'OBJECTION') {
      if (lowerReply.includes('price') || lowerReply.includes('expensive') || lowerReply.includes('cost') || lowerReply.includes('budget')) {
        objection_subtype = 'PRICE';
      } else if (lowerReply.includes('timing') || lowerReply.includes('busy') || lowerReply.includes('later') || lowerReply.includes('time')) {
        objection_subtype = 'TIMING';
      } else if (lowerReply.includes('trust') || lowerReply.includes('reference') || lowerReply.includes('proof') || lowerReply.includes('credib')) {
        objection_subtype = 'TRUST';
      } else if (lowerReply.includes('fit') || lowerReply.includes('feature') || lowerReply.includes('need')) {
        objection_subtype = 'FIT_NEEDS';
      } else {
        objection_subtype = 'OTHER';
      }
    }

    // Determine decision recommendation
    let decision_recommendation = 'DRAFT_ONLY';
    switch(ai_intent) {
      case 'INTERESTED':
        decision_recommendation = 'AUTO_SEND';
        break;
      case 'NOT_NOW':
      case 'GHOSTING':
        decision_recommendation = 'WAIT';
        break;
      case 'OBJECTION':
        decision_recommendation = 'DRAFT_ONLY';
        break;
      case 'DEAD':
        decision_recommendation = 'STOP';
        break;
    }

    lead.ai_intent = ai_intent;
    lead.ai_reasoning = ai_reasoning;
    lead.objection_subtype = objection_subtype;
    lead.decision_recommendation = decision_recommendation;
    lead.last_reply = reply_text;
    lead.last_subject = subject || '(No Subject)';
    lead.status = ai_intent === 'INTERESTED' ? 'interested' : (ai_intent === 'DEAD' ? 'dead' : 'analyzed');

    await db.write();

    res.json({
      ai_intent,
      ai_reasoning,
      objection_subtype,
      decision_recommendation,
      recommendation: 'AI analysis unavailable, using keyword detection',
      lead: {
        id: lead.id,
        first_name: lead.first_name,
        last_name: lead.last_name,
        status: lead.status
      }
    });
  }
});

// ============================================
// EMAIL SYSTEM - IMAP/SMTP
// ============================================

// Save Email Settings (from_name and sending_mode only - OAuth handles email)
app.post('/api/settings/email', authenticate, async (req, res) => {
  const { from_name, sending_mode } = req.body;

  await db.read();

  const existingSettings = db.data.email_settings.find(s => s.user_id === req.userId);

  if (!existingSettings || existingSettings.provider !== 'gmail') {
    return res.status(400).json({ error: 'Please connect your Gmail account first via OAuth' });
  }

  // Only update from_name and sending_mode - OAuth handles the email
  if (from_name !== undefined) existingSettings.from_name = from_name;
  if (sending_mode !== undefined) {
    existingSettings.sending_mode = sending_mode;
    // Sync to user record so auto-reply logic actually fires
    const user = db.data.users.find(u => u.id === req.userId);
    if (user) {
      user.auto_mode_enabled = (sending_mode === 'auto');
      user.email_mode = sending_mode === 'auto' ? 'AUTO' : 'MANUAL';
      user.auto_send_all = (sending_mode === 'auto');
      user.updated_at = new Date().toISOString();
    }
  }
  existingSettings.updated_at = new Date().toISOString();

  await db.write();

  res.json({ success: true, message: 'Email settings saved' });
});

// Disconnect Gmail OAuth
app.delete('/api/auth/google', authenticate, async (req, res) => {
  try {
    await db.read();

    const settings = db.data.email_settings.find(s => s.user_id === req.userId);

    if (settings && settings.provider === 'gmail') {
      // Remove from database
      const index = db.data.email_settings.indexOf(settings);
      if (index > -1) {
        db.data.email_settings.splice(index, 1);
      }
      await db.write();
    }

    res.json({ success: true, message: 'Gmail disconnected' });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Gmail' });
  }
});

// Get Email Settings (OAuth only)
app.get('/api/settings/email', authenticate, async (req, res) => {
  await db.read();

  const settings = db.data.email_settings.find(s => s.user_id === req.userId);

  if (!settings || settings.provider !== 'gmail' || !settings.access_token) {
    return res.json({ configured: false });
  }

  // Return OAuth (Gmail) settings only
  res.json({
    configured: true,
    provider: 'gmail',
    email: settings.email,
    from_name: settings.from_name || '',
    sending_mode: settings.sending_mode || 'manual',
    auto_send_enabled: settings.auto_send_enabled || false,
    last_checked: settings.last_checked
  });
});

// Get AI Automation Settings
app.get('/api/settings/automation', authenticate, async (req, res) => {
  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    ai_automation_enabled: user.ai_automation_enabled || false,
    auto_send_all: user.auto_send_all || false,
    business_type: user.business_type || 'other',
    ai_custom_instructions: user.ai_custom_instructions || '',
    business_knowledge: user.business_knowledge || '',
    live_updates: user.live_updates || ''
  });
});

// Update AI Automation Settings
app.post('/api/settings/automation', authenticate, async (req, res) => {
  const { ai_automation_enabled, auto_send_all, business_type, ai_custom_instructions, business_knowledge, live_updates } = req.body;

  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  user.ai_automation_enabled = ai_automation_enabled !== undefined ? ai_automation_enabled : user.ai_automation_enabled;
  user.auto_send_all = auto_send_all !== undefined ? auto_send_all : user.auto_send_all;
  if (business_type !== undefined) user.business_type = business_type;
  if (ai_custom_instructions !== undefined) user.ai_custom_instructions = ai_custom_instructions;
  if (business_knowledge !== undefined) user.business_knowledge = business_knowledge;
  if (live_updates !== undefined) user.live_updates = live_updates;
  user.updated_at = new Date().toISOString();

  // If knowledge base or live updates changed, reset clarification counts so AI retries
  if (business_knowledge !== undefined || live_updates !== undefined) {
    const userLeads = db.data.leads.filter(l => l.user_id === req.userId);
    userLeads.forEach(l => { l.clarification_count = 0; });
    console.log(`📚 Business knowledge updated — reset clarification count for ${userLeads.length} leads`);
  }

  await db.write();

  res.json({
    success: true,
    ai_automation_enabled: user.ai_automation_enabled,
    auto_send_all: user.auto_send_all,
    business_type: user.business_type || 'other',
    ai_custom_instructions: user.ai_custom_instructions || '',
    business_knowledge: user.business_knowledge || '',
    live_updates: user.live_updates || ''
  });
});

// Get Auto Mode Settings (Unified Auto-Send Configuration)
app.get('/api/settings/auto-mode', authenticate, async (req, res) => {
  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    auto_mode_enabled: user.auto_mode_enabled || false,
    auto_mode_include_objections: user.auto_mode_include_objections || false,
    // Legacy fields for backward compatibility
    email_mode: user.auto_mode_enabled ? 'AUTO' : 'MANUAL',
    auto_send_all: user.auto_mode_enabled || false
  });
});

// Update Auto Mode Settings (Unified Auto-Send Configuration)
app.post('/api/settings/auto-mode', authenticate, async (req, res) => {
  const { auto_mode_enabled, auto_mode_include_objections } = req.body;

  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Update auto mode settings
  if (auto_mode_enabled !== undefined) {
    user.auto_mode_enabled = auto_mode_enabled;
  }

  if (auto_mode_include_objections !== undefined) {
    user.auto_mode_include_objections = auto_mode_include_objections;
  }

  // Keep legacy fields in sync for backward compatibility
  user.email_mode = user.auto_mode_enabled ? 'AUTO' : 'MANUAL';
  user.auto_send_all = user.auto_mode_enabled || false;

  user.updated_at = new Date().toISOString();

  await db.write();

  res.json({
    success: true,
    auto_mode_enabled: user.auto_mode_enabled,
    auto_mode_include_objections: user.auto_mode_include_objections,
    message: user.auto_mode_enabled ? '✅ Auto Mode enabled - emails will be sent automatically' : '📝 Manual Mode enabled - emails will require approval'
  });
});

// SELLER PROFILE - Your own contact info used in AI-generated emails
// ============================================

// Get Seller Profile
app.get('/api/settings/seller-profile', authenticate, async (req, res) => {
  await db.read();
  const profile = db.data.seller_profiles.find(p => p.user_id === req.userId);
  if (!profile) return res.json({ configured: false });
  res.json({ configured: true, ...profile });
});

// Save Seller Profile
app.post('/api/settings/seller-profile', authenticate, async (req, res) => {
  const { seller_name, seller_company, seller_email, seller_phone, seller_website, seller_social, seller_signature } = req.body;
  await db.read();

  const existing = db.data.seller_profiles.findIndex(p => p.user_id === req.userId);
  const record = {
    user_id: req.userId,
    seller_name: seller_name || '',
    seller_company: seller_company || '',
    seller_email: seller_email || '',
    seller_phone: seller_phone || '',
    seller_website: seller_website || '',
    seller_social: seller_social || '',
    seller_signature: seller_signature || '',
    updated_at: new Date().toISOString()
  };

  if (existing >= 0) {
    db.data.seller_profiles[existing] = { ...db.data.seller_profiles[existing], ...record };
  } else {
    db.data.seller_profiles.push({ id: Date.now(), created_at: new Date().toISOString(), ...record });
  }

  await db.write();
  res.json({ success: true, seller_profile: record });
});

// PRODUCT PROFILE - For AI Email Generation Context
// ============================================

// Get Product Profile
app.get('/api/settings/product-profile', authenticate, async (req, res) => {
  await db.read();

  const profile = db.data.product_profiles.find(p => p.user_id === req.userId);

  if (!profile) {
    return res.json({ configured: false });
  }

  res.json({
    configured: true,
    ...profile
  });
});

// Save Product Profile
app.post('/api/settings/product-profile', authenticate, async (req, res) => {
  const {
    product_name,
    product_description,
    key_benefits,
    target_audience,
    pain_points,
    unique_selling_points,
    success_stories,
    special_offers,
    call_to_action
  } = req.body;

  await db.read();

  const existingProfile = db.data.product_profiles.find(p => p.user_id === req.userId);

  const profile = {
    user_id: req.userId,
    product_name,
    product_description,
    key_benefits,
    target_audience,
    pain_points,
    unique_selling_points,
    success_stories,
    special_offers,
    call_to_action,
    updated_at: new Date().toISOString()
  };

  if (existingProfile) {
    Object.assign(existingProfile, profile);
  } else {
    profile.id = db.data.product_profiles.length + 1;
    profile.created_at = new Date().toISOString();
    db.data.product_profiles.push(profile);
  }

  // Reset clarification_count for all user's leads — knowledge base updated, AI can retry
  const userLeads = db.data.leads.filter(l => l.user_id === req.userId);
  userLeads.forEach(l => { l.clarification_count = 0; });

  await db.write();
  console.log(`📚 Product profile updated — reset clarification count for ${userLeads.length} leads`);

  res.json({ success: true, message: 'Product profile saved' });
});

// Delete Product Profile + clear business_knowledge/live_updates
app.delete('/api/settings/product-profile', authenticate, async (req, res) => {
  await db.read();
  db.data.product_profiles = db.data.product_profiles.filter(p => p.user_id !== req.userId);
  const user = db.data.users.find(u => u.id === req.userId);
  if (user) {
    user.business_knowledge = '';
    user.live_updates = '';
  }
  const userLeads = db.data.leads.filter(l => l.user_id === req.userId);
  userLeads.forEach(l => { l.clarification_count = 0; });
  await db.write();
  console.log(`🗑️  Product profile + knowledge cleared for user ${req.userId}`);
  res.json({ success: true });
});

// Smart AI Product Extraction - Upload files/URLs/text and AI extracts product info
// ============================================

// Configure multer for file uploads (product extraction)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                          'application/msword', 'text/plain', 'text/csv', 'application/vnd.ms-powerpoint',
                          'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(pdf|docx|doc|txt|csv|ppt|pptx)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Supported: PDF, DOCX, TXT, CSV, PPT'));
    }
  }
});

// Configure multer for email attachments (includes images)
const emailAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword', 'text/plain', 'text/csv',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    if (allowedTypes.includes(file.mimetype) ||
        file.originalname.match(/\.(jpg|jpeg|png|gif|webp|svg|pdf|docx|doc|txt|csv|ppt|pptx|xls|xlsx)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Supported: images, PDF, DOCX, TXT, CSV, PPT, XLS'));
    }
  }
});

// Email Attachment Upload Endpoint
app.post('/api/email/upload-attachment', authenticate, emailAttachmentUpload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Return file as base64 for frontend to store temporarily
    res.json({
      filename: file.originalname,
      content_type: file.mimetype,
      size: file.size,
      content: file.buffer.toString('base64')
    });
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to upload file' });
  }
});

// AI Product Extraction Endpoint
app.post('/api/settings/product-extract', authenticate, upload.single('file'), async (req, res) => {
  console.log('📤 Product extraction request received');
  console.log('File:', req.file ? req.file.originalname : 'None');
  console.log('URL:', req.body.url || 'None');
  console.log('Text:', req.body.text_content ? 'Yes' : 'None');

  try {
    const { url, text_content } = req.body;
    const file = req.file;

    if (!file && !url && !text_content) {
      console.log('❌ Error: No content provided');
      return res.status(400).json({ error: 'Please provide a file, URL, or text content' });
    }

    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'demo-mode') {
      console.log('❌ Error: ANTHROPIC_API_KEY not set');
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set' });
    }

    console.log('✅ Starting AI extraction...');

    let extractedText = '';

    // Extract text from file
    if (file) {
      try {
        if (file.mimetype === 'application/pdf' || file.originalname.endsWith('.pdf')) {
          // Import and use pdf-parse v2.x (class-based API)
          const { PDFParse } = await import('pdf-parse');
          const parser = new PDFParse({ data: file.buffer });
          const result = await parser.getText();
          await parser.destroy(); // Clean up resources
          console.log('✅ PDF extracted, text length:', result.text.length);
          extractedText = result.text;
        } else if (file.mimetype.includes('wordprocessingml') || file.originalname.match(/\.docx?$/i)) {
          const result = await mammoth.extractRawText({ buffer: file.buffer });
          extractedText = result.value;
        } else if (file.mimetype === 'text/plain' || file.originalname.endsWith('.txt')) {
          extractedText = file.buffer.toString('utf-8');
        } else if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
          extractedText = file.buffer.toString('utf-8');
        } else if (file.originalname.match(/\.pptx?$/i)) {
          // For PPT, extract what we can (basic text extraction)
          extractedText = file.buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ');
        }
      } catch (parseError) {
        console.error('File parsing error:', parseError);
        return res.status(400).json({ error: 'Failed to parse file. Please try a different format.' });
      }
    }

    // Extract text from URL
    if (url) {
      try {
        const urlResponse = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await urlResponse.text();
        const $ = cheerioLoad(html);

        // Remove scripts, styles, etc.
        $('script, style, nav, footer, iframe').remove();

        // Get main content
        extractedText = $('body').text().replace(/\s+/g, ' ').trim();
      } catch (urlError) {
        console.error('URL fetch error:', urlError);
        return res.status(400).json({ error: 'Failed to fetch URL. Please check the URL and try again.' });
      }
    }

    // Use provided text
    if (text_content) {
      extractedText += '\n\n' + text_content;
    }

    // Limit text length for AI processing
    if (extractedText.length > 20000) {
      extractedText = extractedText.substring(0, 20000) + '... (truncated)';
    }

    // Use Claude AI to extract product information
    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are a data extraction specialist. Extract product information from the following content. ONLY extract information that is explicitly stated. Do NOT infer, assume, or generate information not directly mentioned.

CONTENT:
${extractedText}

Extract the following information in a structured JSON format. Only include fields that have explicit information in the content. Leave fields empty if information is not mentioned:
{
  "product_name": "The actual name of the product/service mentioned",
  "product_description": "A brief description of what it is - only what is stated",
  "key_benefits": "Benefits explicitly mentioned - do not infer",
  "target_audience": "Who it's explicitly described as being for",
  "pain_points": "Problems it solves - only if explicitly stated",
  "unique_selling_points": "Unique aspects explicitly mentioned",
  "success_stories": "Testimonials, case studies, or results explicitly mentioned",
  "special_offers": "Pricing, discounts, or offers explicitly mentioned",
  "call_to_action": "Any call-to-action explicitly provided"
}

Rules:
- ONLY extract what is explicitly stated in the content
- Do NOT infer, guess, or assume any information
- Do NOT generate marketing language or persuasive copy
- If a field has no explicit information, leave it as empty string ""
- Keep extracted information factual and brief

Return ONLY the JSON, no other text.`
        }]
      })
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('❌ AI API Error:', aiResponse.status, errorText);
      throw new Error(`AI extraction failed: ${aiResponse.status} - ${errorText.substring(0, 200)}`);
    }

    const aiData = await aiResponse.json();
    console.log('✅ AI responded successfully');
    let productInfo;

    try {
      const jsonText = aiData.content[0].text.trim();
      // Remove markdown code blocks if present
      const cleanJson = jsonText.replace(/```json\n?|\n?```/g, '').trim();
      productInfo = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }

    // Save to database with smart merging
    await db.read();
    const existingProfile = db.data.product_profiles.find(p => p.user_id === req.userId);

    if (existingProfile) {
      // Merge strategy: Keep existing data, add/update with new info only if new info is not empty
      for (const key in productInfo) {
        if (productInfo[key] && productInfo[key].trim && productInfo[key].trim() !== '') {
          // New info is not empty, use it
          existingProfile[key] = productInfo[key];
        } else if (!existingProfile[key]) {
          // New info is empty, but existing key doesn't exist yet
          existingProfile[key] = productInfo[key];
        }
        // Otherwise keep existing value
      }
      existingProfile.updated_at = new Date().toISOString();
      // Return the merged result
      productInfo = existingProfile;
    } else {
      // New profile
      const profile = {
        user_id: req.userId,
        ...productInfo,
        id: db.data.product_profiles.length + 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      db.data.product_profiles.push(profile);
    }

    await db.write();

    console.log('✅ AI extraction successful!');
    console.log('Product:', productInfo.product_name);

    res.json({
      success: true,
      message: '✨ AI successfully learned about your product!',
      extracted: productInfo  // Changed from extracted_info to match frontend expectation
    });

  } catch (error) {
    console.error('❌ Product extraction error:', error);
    res.status(500).json({ error: 'Failed to extract product information: ' + error.message });
  }
});

// ============================================
// EMAIL TEMPLATES - UNLAYER INTEGRATION
// ============================================

// Get all email templates for user
app.get('/api/templates', authenticate, async (req, res) => {
  await db.read();

  const templates = db.data.email_templates.filter(t => t.user_id === req.userId);

  res.json({ templates });
});

// Get single template
app.get('/api/templates/:id', authenticate, async (req, res) => {
  await db.read();

  const template = db.data.email_templates.find(t =>
    t.id === parseInt(req.params.id) && t.user_id === req.userId
  );

  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  res.json({ template });
});

// Create new template
app.post('/api/templates', authenticate, async (req, res) => {
  const { name, subject, design_json, html } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Template name is required' });
  }

  await db.read();

  const template = {
    id: db.data.email_templates.length + 1,
    user_id: req.userId,
    name,
    subject: subject || '',
    design_json: design_json || null, // Unlayer design JSON
    html: html || '', // Exported HTML
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.data.email_templates.push(template);
  await db.write();

  res.json({ template, message: 'Template created successfully' });
});

// Update existing template
app.put('/api/templates/:id', authenticate, async (req, res) => {
  const { name, subject, design_json, html } = req.body;

  await db.read();

  const template = db.data.email_templates.find(t =>
    t.id === parseInt(req.params.id) && t.user_id === req.userId
  );

  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  // Update template fields
  if (name !== undefined) template.name = name;
  if (subject !== undefined) template.subject = subject;
  if (design_json !== undefined) template.design_json = design_json;
  if (html !== undefined) template.html = html;
  template.updated_at = new Date().toISOString();

  await db.write();

  res.json({ template, message: 'Template updated successfully' });
});

// Delete template
app.delete('/api/templates/:id', authenticate, async (req, res) => {
  await db.read();

  const templateIndex = db.data.email_templates.findIndex(t =>
    t.id === parseInt(req.params.id) && t.user_id === req.userId
  );

  if (templateIndex === -1) {
    return res.status(404).json({ error: 'Template not found' });
  }

  db.data.email_templates.splice(templateIndex, 1);
  await db.write();

  res.json({ message: 'Template deleted successfully' });
});

// Update lead fields (ai_intent, status, notes, etc.)
app.patch('/api/leads/:id', authenticate, async (req, res) => {
  await db.read();

  // Use string comparison to avoid number/string type mismatch
  const lead = db.data.leads.find(l =>
    String(l.id) === String(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    console.error(`PATCH /leads/:id — lead not found. id=${req.params.id} userId=${req.userId}`);
    return res.status(404).json({ error: 'Lead not found' });
  }

  const allowed = ['ai_intent', 'status', 'first_name', 'last_name', 'company', 'phone', 'notes', 'objection_subtype'];
  allowed.forEach(field => {
    if (req.body[field] !== undefined) {
      lead[field] = req.body[field];
    }
  });
  lead.updated_at = new Date().toISOString();

  await db.write();
  res.json({ lead });
});

// Toggle per-lead auto-send setting
app.patch('/api/leads/:id/auto-send', authenticate, async (req, res) => {
  const { auto_send_enabled } = req.body;

  await db.read();

  const lead = db.data.leads.find(l =>
    l.id === parseInt(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  lead.auto_send_enabled = auto_send_enabled;
  lead.updated_at = new Date().toISOString();

  await db.write();

  res.json({
    success: true,
    lead_id: lead.id,
    auto_send_enabled: lead.auto_send_enabled
  });
});

// Resume AI for a lead after human handoff
app.patch('/api/leads/:id/resume-ai', authenticate, async (req, res) => {
  await db.read();

  const lead = db.data.leads.find(l =>
    String(l.id) === String(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  lead.ai_paused_by_human = false;
  lead.last_email_sender = null;
  lead.updated_at = new Date().toISOString();

  await db.write();

  res.json({ success: true, lead });
});

// Pause / resume follow-up rules for a specific lead
app.post('/api/leads/:id/pause-follow-ups', authenticate, async (req, res) => {
  await db.read();

  const lead = db.data.leads.find(l =>
    String(l.id) === String(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const { paused } = req.body; // true = stop, false = resume
  lead.follow_up_paused = paused === true;
  lead.updated_at = new Date().toISOString();

  // If pausing, immediately delete any pending AI drafts for this lead
  // (fixes concurrency bug where processFollowUps might overwrite the pause flag)
  if (paused === true && db.data.ai_drafts) {
    const beforeCount = db.data.ai_drafts.length;
    db.data.ai_drafts = db.data.ai_drafts.filter(d => d.lead_id !== lead.id);
    const deletedCount = beforeCount - db.data.ai_drafts.length;
    if (deletedCount > 0) {
      console.log(`🛑 Paused follow-ups for lead ${lead.id} — deleted ${deletedCount} pending draft(s)`);
    }
  }

  await db.write();

  res.json({ success: true, lead });
});

// Stop sequence for a specific lead
app.post('/api/leads/:id/stop-sequence', authenticate, async (req, res) => {
  await db.read();

  const lead = db.data.leads.find(l =>
    String(l.id) === String(req.params.id) && l.user_id === req.userId
  );

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  if (!lead.enrolled_sequence_id) {
    return res.status(400).json({ error: 'Lead is not enrolled in any sequence' });
  }

  lead.sequence_paused = true;
  lead.sequence_completed = true;
  lead.updated_at = new Date().toISOString();

  await db.write();

  res.json({ success: true, lead });
});

// Get Follow-Up Rules (per_intent_settings)
app.get('/api/settings/follow-up-rules', authenticate, async (req, res) => {
  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Default follow-up rules if none exist
  const defaultRules = {
    INTERESTED: { delay_days: 1, max_attempts: 5, after_max: 'review' },
    NOT_NOW: { delay_days: 7, max_attempts: 3, after_max: 'GHOSTING' },
    OBJECTION: { delay_days: 3, max_attempts: 4, after_max: 'review' },
    GHOSTING: { delay_days: 5, max_attempts: 3, after_max: 'DEAD' },
    DEAD: { delay_days: 30, max_attempts: 1, after_max: 'closed_by_system' }
  };

  res.json({
    follow_up_rules: user.per_intent_settings || defaultRules,
    email_mode: user.email_mode || 'MANUAL' // MANUAL or AUTO
  });
});

// Get A/B Test Results
app.get('/api/settings/ab-results', authenticate, async (req, res) => {
  await db.read();
  const userId = req.userId;

  const results = (db.data.ab_results || []).filter(r => r.user_id === userId);

  const stats = results.map(r => {
    const aRate = r.variant_a_sends > 0 ? (r.variant_a_replies / r.variant_a_sends * 100).toFixed(1) : '0.0';
    const bRate = r.variant_b_sends > 0 ? (r.variant_b_replies / r.variant_b_sends * 100).toFixed(1) : '0.0';
    return {
      intent: r.intent,
      variant_a: { sends: r.variant_a_sends, replies: r.variant_a_replies, reply_rate: `${aRate}%` },
      variant_b: { sends: r.variant_b_sends, replies: r.variant_b_replies, reply_rate: `${bRate}%` },
      winner: r.winner || null,
      winning_emails_count: (db.data.winning_emails || []).filter(w => w.user_id === userId && w.intent_triggered === r.intent).length
    };
  });

  res.json({ ab_results: stats });
});

// Update Follow-Up Rules (per_intent_settings)
app.post('/api/settings/follow-up-rules', authenticate, async (req, res) => {
  const { follow_up_rules, email_mode } = req.body;

  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (follow_up_rules) {
    user.per_intent_settings = follow_up_rules;
  }

  if (email_mode) {
    user.email_mode = email_mode;
    // Sync auto_mode_enabled with email_mode for unified auto-send logic
    user.auto_mode_enabled = (email_mode === 'AUTO');
  }

  user.updated_at = new Date().toISOString();

  await db.write();

  res.json({
    success: true,
    follow_up_rules: user.per_intent_settings,
    email_mode: user.email_mode,
    auto_mode_enabled: user.auto_mode_enabled
  });
});

// Check for New Email Replies (Manual trigger)
app.post('/api/emails/check', authenticate, async (req, res) => {
  await db.read();

  const settings = db.data.email_settings.find(s => s.user_id === req.userId);

  if (!settings) {
    return res.status(400).json({ error: 'Email not configured. Please add your email settings first.' });
  }

  try {
    let newReplies;

    // Use Gmail API if OAuth is configured, otherwise fall back to IMAP
    if (settings.provider === 'gmail' && settings.access_token) {
      console.log('📧 Using Gmail API to check emails...');
      newReplies = await checkGmailReplies(settings, req.userId);
    } else {
      console.log('📧 Using IMAP to check emails...');
      newReplies = await checkEmailReplies(settings, req.userId);
    }

    settings.last_checked = new Date().toISOString();
    await db.write();

    res.json({
      success: true,
      new_replies: newReplies.length,
      replies: newReplies
    });
  } catch (error) {
    console.error('Email check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ⚡ Enable Gmail Push Notifications (instant email delivery)
app.post('/api/emails/enable-push', authenticate, async (req, res) => {
  try {
    await db.read();

    const settings = db.data.email_settings.find(s => s.user_id === req.userId);

    if (!settings) {
      return res.status(400).json({ error: 'Email not configured. Please add your email settings first.' });
    }

    if (settings.provider !== 'gmail' || !settings.access_token) {
      return res.status(400).json({ error: 'Gmail API must be configured first.' });
    }

    if (!process.env.GOOGLE_CLOUD_PROJECT_ID) {
      return res.status(500).json({ error: 'Google Cloud Project ID not configured on server.' });
    }

    // Set up Gmail Push Notifications
    const result = await setupGmailPushNotifications(settings, req.userId);

    res.json({
      success: true,
      message: 'Gmail Push Notifications enabled! Emails will now arrive instantly.',
      expiration: result.expiration,
      note: 'Push notifications expire after 7 days. They will be automatically renewed.'
    });
  } catch (error) {
    console.error('Error enabling Gmail Push:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get email interactions/threads for inbox view
app.get('/api/emails/interactions', authenticate, async (req, res) => {
  try {
    await db.read();

    // Get all email threads for this user
    const emailThreads = db.data.email_threads.filter(thread => thread.user_id === req.userId);

    // Enrich threads with lead information
    const enrichedThreads = emailThreads.map(thread => {
      const lead = db.data.leads.find(l => l.id === thread.lead_id);
      return {
        ...thread,
        lead_name: lead ? `${lead.first_name} ${lead.last_name}`.trim() : 'Unknown',
        lead_email: lead?.email || thread.from,
        lead_company: lead?.company || '',
        lead_status: lead?.status || 'unknown'
      };
    });

    // Sort by most recent first
    enrichedThreads.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));

    res.json({
      success: true,
      threads: enrichedThreads,
      total: enrichedThreads.length
    });
  } catch (error) {
    console.error('Error fetching email interactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get email interactions for a specific lead
app.get('/api/emails/interactions/:leadId', authenticate, async (req, res) => {
  try {
    await db.read();

    const leadId = parseInt(req.params.leadId);
    const lead = db.data.leads.find(l => l.id === leadId && l.user_id === req.userId);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Get all threads for this lead
    const threads = db.data.email_threads.filter(t => t.lead_id === leadId);

    // Get AI drafts: in manual mode show all pending; in auto mode show only needs_follow_up
    let drafts = [];
    const user = db.data.users.find(u => u.id === req.userId);
    const isManualMode = !user || !user.auto_mode_enabled;

    if (isManualMode) {
      drafts = db.data.ai_drafts.filter(d => d.lead_id === leadId && d.status === 'pending');
    } else {
      // Auto mode: show drafts that need human follow-up (AI couldn't answer)
      drafts = db.data.ai_drafts.filter(d => d.lead_id === leadId && d.status === 'pending' && d.needs_follow_up);
    }

    // Get all AI replies that were actually sent (for timeline — always include)
    const sentReplies = (db.data.ai_drafts || []).filter(d => d.lead_id === leadId && d.status === 'sent');

    // Get sent initial/follow-up emails from email_history (for timeline)
    const emailHistory = (db.data.email_history || []).filter(h => h.lead_id === leadId);

    // Get sequence emails from email_interactions (sent via sequences)
    const sequenceInteractions = (db.data.email_interactions || [])
      .filter(i => i.lead_id === leadId && i.direction === 'sent');
    const sequenceEmails = sequenceInteractions.map(interaction => {
      const seq = (db.data.sequences || []).find(s => s.id === interaction.sequence_id);
      const totalSteps = seq ? (db.data.sequence_steps || []).filter(s => s.sequence_id === seq.id).length : 0;
      return {
        ...interaction,
        sequence_name: seq ? seq.name : 'Sequence',
        total_steps: totalSteps
      };
    });

    // Remove backend-only fields before sending to frontend
    const { ai_paused_by_human, last_email_sender, ...safeLead } = lead;

    res.json({
      success: true,
      lead: {
        id: safeLead.id,
        name: `${safeLead.first_name} ${safeLead.last_name}`.trim(),
        email: safeLead.email,
        company: safeLead.company,
        status: safeLead.status
      },
      threads: threads.sort((a, b) => new Date(b.received_at) - new Date(a.received_at)),
      drafts: drafts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
      sent_replies: sentReplies.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at)),
      email_history: emailHistory.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at)),
      sequence_emails: sequenceEmails.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
    });
  } catch (error) {
    console.error('Error fetching lead interactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unnotified email threads (for notifications)
app.get('/api/emails/notifications', authenticate, async (req, res) => {
  try {
    await db.read();

    // Get all unnotified email threads for this user
    const unnotifiedThreads = db.data.email_threads.filter(
      thread => thread.user_id === req.userId && thread.notified === false
    );

    // Enrich with lead information
    const enrichedNotifications = unnotifiedThreads.map(thread => {
      const lead = db.data.leads.find(l => l.id === thread.lead_id);
      return {
        id: thread.id,
        subject: thread.subject,
        body: thread.body,
        from: thread.from,
        received_at: thread.received_at,
        ai_intent: thread.ai_intent,
        lead_id: thread.lead_id,
        lead_name: lead ? `${lead.first_name} ${lead.last_name}`.trim() : 'Unknown',
        lead_company: lead?.company || '',
        lead_email: lead?.email || thread.from
      };
    });

    // Sort by most recent first
    enrichedNotifications.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));

    res.json({
      success: true,
      notifications: enrichedNotifications,
      count: enrichedNotifications.length
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark email threads as notified
app.post('/api/emails/mark-notified', authenticate, async (req, res) => {
  try {
    const { threadIds } = req.body;

    if (!threadIds || !Array.isArray(threadIds)) {
      return res.status(400).json({ error: 'threadIds array is required' });
    }

    await db.read();

    let updatedCount = 0;
    for (const threadId of threadIds) {
      const thread = db.data.email_threads.find(
        t => t.id === threadId && t.user_id === req.userId
      );
      if (thread) {
        thread.notified = true;
        updatedCount++;
      }
    }

    await db.write();

    res.json({
      success: true,
      updated: updatedCount
    });
  } catch (error) {
    console.error('Error marking threads as notified:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up duplicate email threads (removes duplicates based on body + lead_id)
app.post('/api/emails/cleanup-duplicates', authenticate, async (req, res) => {
  try {
    await db.read();

    const beforeCount = db.data.email_threads.length;

    // Group threads by lead_id and body
    const seen = new Map();
    const uniqueThreads = [];

    for (const thread of db.data.email_threads) {
      if (thread.user_id !== req.userId) {
        uniqueThreads.push(thread); // Keep threads from other users
        continue;
      }

      // Create unique key from lead_id + body + subject
      const key = `${thread.lead_id}_${thread.subject}_${thread.body.substring(0, 100)}`;

      if (!seen.has(key)) {
        seen.set(key, true);
        uniqueThreads.push(thread);
      } else {
        console.log(`🗑️  Removing duplicate thread: ${thread.subject}`);
      }
    }

    // Update database with unique threads only
    db.data.email_threads = uniqueThreads;
    await db.write();

    const removedCount = beforeCount - uniqueThreads.length;

    res.json({
      success: true,
      removed: removedCount,
      message: `Removed ${removedCount} duplicate email${removedCount !== 1 ? 's' : ''}`
    });
  } catch (error) {
    console.error('Error cleaning up duplicates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Function to check IMAP for new replies
async function checkEmailReplies(settings, userId) {
  return new Promise((resolve, reject) => {
    const imapConfig = {
      ...settings.imap,
      tlsOptions: { rejectUnauthorized: false } // Fix for self-signed certificate issues
    };
    const imap = new Imap(imapConfig);
    const newReplies = [];
    
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Search for unseen emails from last 7 days
        const searchCriteria = ['UNSEEN', ['SINCE', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)]];
        
        imap.search(searchCriteria, (err, results) => {
          if (err) {
            reject(err);
            return;
          }
          
          if (results.length === 0) {
            imap.end();
            resolve(newReplies);
            return;
          }
          
          const fetch = imap.fetch(results, { bodies: '' });
          
          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (err) return;
                
                // Find matching lead by email
                await db.read();
                const lead = db.data.leads.find(l => 
                  l.user_id === userId && 
                  l.email.toLowerCase() === parsed.from.value[0].address.toLowerCase()
                );
                
                if (lead) {
                  // Extract plain text from HTML if text part is missing
                  const parsedBody = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '');
                  // Analyze with AI (including subject line)
                  const analysis = await analyzeReplyWithAI(parsedBody, parsed.subject || '');

                  // Update lead — but don't overwrite INTERESTED with a vague GHOSTING reply.
                  // Once a lead shows interest, keep them INTERESTED unless they explicitly decline.
                  const prevIntent = lead.ai_intent;
                  const shouldUpdateIntent = !(prevIntent === 'INTERESTED' && analysis.intent === 'GHOSTING');
                  if (shouldUpdateIntent) {
                    // If intent changed, reset follow-up counter so new rules apply fresh
                    if (prevIntent && prevIntent !== analysis.intent) {
                      lead.follow_up_count = 0;
                    }
                    lead.ai_intent = analysis.intent;
                  }
                  lead.ai_reasoning = analysis.reasoning;
                  lead.last_reply = parsedBody;
                  lead.last_reply_date = new Date().toISOString();
                  lead.last_subject = parsed.subject || '(No Subject)';
                  lead.status = lead.ai_intent === 'INTERESTED' ? 'interested' : (lead.ai_intent === 'DEAD' ? 'dead' : 'analyzed');

                  // Store email thread
                  db.data.email_threads.push({
                    id: db.data.email_threads.length + 1,
                    lead_id: lead.id,
                    user_id: userId,
                    from: parsed.from.value[0].address,
                    subject: parsed.subject,
                    body: parsedBody,
                    received_at: new Date().toISOString(),
                    ai_intent: analysis.intent,
                    notified: false // Track if user has been notified about this email
                  });

                  // Save winning email + track A/B reply if positive intent (IMAP path)
                  if (['INTERESTED', 'NOT_NOW', 'OBJECTION'].includes(analysis.intent)) {
                    const lastSent = (db.data.email_history || [])
                      .filter(h => h.lead_id === lead.id)
                      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
                    if (lastSent) {
                      if (!db.data.winning_emails) db.data.winning_emails = [];
                      const userWinning = db.data.winning_emails.filter(w => w.user_id === userId);
                      if (userWinning.length >= 50) {
                        const oldest = userWinning[0];
                        db.data.winning_emails = db.data.winning_emails.filter(w => w.id !== oldest.id);
                      }
                      db.data.winning_emails.push({
                        id: (db.data.winning_emails.length || 0) + 1,
                        user_id: userId,
                        lead_id: lead.id,
                        subject: lastSent.subject || '',
                        body: lastSent.body || '',
                        intent_triggered: analysis.intent,
                        created_at: new Date().toISOString()
                      });
                      if (lastSent.ab_variant && db.data.ab_results) {
                        const abRec = db.data.ab_results.find(r => r.user_id === userId && r.intent === (lead.ai_intent || 'GHOSTING'));
                        if (abRec) {
                          if (lastSent.ab_variant === 'A') abRec.variant_a_replies++;
                          else abRec.variant_b_replies++;
                        }
                      }
                    }
                  }

                  await db.write();
                  
                  // Generate AI response for ALL intents (reply to every customer message)
                  // But first check if a draft already exists for this email thread to prevent duplicates
                  const existingDraftImap = (db.data.ai_drafts || []).find(d =>
                    d.lead_id === lead.id &&
                    d.reply_subject === (parsed.subject || '') &&
                    d.reply_text === parsedBody &&
                    d.status === 'pending'
                  );

                  let draft = null;
                  let draftClarificationNeeded = false;
                  if (!existingDraftImap) {
                    const aiResult = await generateAIResponse(lead, parsedBody, analysis.intent, parsed.subject || '');
                    if (aiResult) {
                      draft = aiResult.body;
                      draftClarificationNeeded = aiResult.clarification_needed || false;
                    }
                  } else {
                    console.log(`⏭️  Draft already exists for this reply from ${lead.first_name} (IMAP) — skipping duplicate generation`);
                  }

                  const user = db.data.users.find(u => u.id === userId);
                  const isAutoMode = user && (user.auto_mode_enabled || user.email_mode === 'AUTO');

                  // Safety: never send blank emails
                  if (draft && !draft.trim()) {
                    console.log(`⚠️  Empty draft body for lead ${lead.id} (${lead.first_name}) — skipping send, saving as draft`);
                    draft = null;
                  }

                  if (draft) {
                    const shouldAutoSend = isAutoMode && lead.auto_send_enabled !== false;
                    const alreadySentHolding = (lead.clarification_count || 0) >= 1;

                    if (shouldAutoSend && draftClarificationNeeded && alreadySentHolding) {
                      // STOP: Already sent holding reply before. Save draft, don't send.
                      console.log(`🛑 STOPPED auto-reply for ${lead.first_name} — already sent holding reply. Saving draft for manual follow-up.`);
                      lead.clarification_count = (lead.clarification_count || 0) + 1;
                      db.data.ai_drafts.push({
                        id: db.data.ai_drafts.length + 1,
                        lead_id: lead.id,
                        user_id: userId,
                        draft_body: draft,
                        ai_intent: analysis.intent,
                        reply_text: parsedBody,
                        reply_subject: parsed.subject || '',
                        status: 'pending',
                        clarification_needed: true,
                        needs_follow_up: true,
                        created_at: new Date().toISOString()
                      });
                      await db.write();

                      newReplies.push({
                        lead_id: lead.id,
                        lead_name: `${lead.first_name} ${lead.last_name}`,
                        intent: analysis.intent,
                        draft_generated: true,
                        needs_follow_up: true,
                        auto_paused_clarification: true
                      });
                    } else if (shouldAutoSend) {
                      // AUTO MODE: Send immediately
                      try {
                        const autoSendResult = await sendEmail(settings, lead.email, `Re: ${parsed.subject}`, draft, null, {
                          lead_id: lead.id
                        });
                        // Store sent email so future replies thread correctly
                        if (!db.data.email_interactions) db.data.email_interactions = [];
                        db.data.email_interactions.push({
                          id: db.data.email_interactions.length + 1,
                          lead_id: lead.id,
                          user_id: userId,
                          direction: 'sent',
                          subject: `Re: ${parsed.subject}`,
                          body: draft,
                          message_id: autoSendResult.threading_message_id,
                          sent_at: new Date().toISOString()
                        });
                        console.log(`🚀 AUTO-SENT immediate reply to ${lead.first_name} (Intent: ${analysis.intent})${draftClarificationNeeded ? ' [HOLDING REPLY - needs follow-up]' : ''} - Auto Mode enabled`);
                        lead.status = 'replied';

                        if (draftClarificationNeeded) {
                          lead.clarification_count = (lead.clarification_count || 0) + 1;
                          db.data.ai_drafts.push({
                            id: db.data.ai_drafts.length + 1,
                            lead_id: lead.id,
                            user_id: userId,
                            draft_body: draft,
                            ai_intent: analysis.intent,
                            reply_text: parsedBody,
                            reply_subject: parsed.subject || '',
                            status: 'sent',
                            clarification_needed: true,
                            needs_follow_up: true,
                            created_at: new Date().toISOString(),
                            sent_at: new Date().toISOString()
                          });
                          console.log(`📋 Holding reply sent to ${lead.first_name} — flagged for your follow-up`);
                        } else {
                          lead.clarification_count = 0;
                          resolveStaleActionRequiredDrafts(lead.id);
                        }
                        await db.write();

                        newReplies.push({
                          lead_id: lead.id,
                          lead_name: `${lead.first_name} ${lead.last_name}`,
                          intent: analysis.intent,
                          draft_generated: false,
                          auto_sent: true,
                          needs_follow_up: draftClarificationNeeded
                        });
                      } catch (sendError) {
                        console.error(`❌ Failed to auto-send to ${lead.first_name}:`, sendError.message);
                        db.data.ai_drafts.push({
                          id: db.data.ai_drafts.length + 1,
                          lead_id: lead.id,
                          user_id: userId,
                          draft_body: draft,
                          ai_intent: analysis.intent,
                          reply_text: parsedBody,
                          reply_subject: parsed.subject || '',
                          status: 'pending',
                          clarification_needed: draftClarificationNeeded,
                          created_at: new Date().toISOString()
                        });
                        await db.write();

                        newReplies.push({
                          lead_id: lead.id,
                          lead_name: `${lead.first_name} ${lead.last_name}`,
                          intent: analysis.intent,
                          draft_generated: true,
                          auto_send_failed: true
                        });
                      }
                    } else {
                      // MANUAL MODE: Save as draft for user review
                      if (draftClarificationNeeded) {
                        console.log(`⚠️  Clarification needed for lead ${lead.id} (${lead.first_name}) — question not in knowledge base. Draft saved for manual reply.`);
                      }
                      // Resolve stale Action Required drafts when new correct reply is generated
                      if (!draftClarificationNeeded) {
                        resolveStaleActionRequiredDrafts(lead.id);
                      }
                      db.data.ai_drafts.push({
                        id: db.data.ai_drafts.length + 1,
                        lead_id: lead.id,
                        user_id: userId,
                        draft_body: draft,
                        ai_intent: analysis.intent,
                        reply_text: parsedBody,
                        reply_subject: parsed.subject || '',
                        status: 'pending',
                        clarification_needed: draftClarificationNeeded,
                        created_at: new Date().toISOString()
                      });
                      await db.write();

                      newReplies.push({
                        lead_id: lead.id,
                        lead_name: `${lead.first_name} ${lead.last_name}`,
                        intent: analysis.intent,
                        draft_generated: true,
                        clarification_needed: draftClarificationNeeded
                      });
                    }
                  }
                }
              });
            });
          });
          
          fetch.once('end', () => {
            imap.end();
            resolve(newReplies);
          });
        });
      });
    });
    
    imap.once('error', (err) => {
      reject(err);
    });
    
    imap.connect();
  });
}

// Function to check Gmail API for new replies (better than IMAP)
async function checkGmailReplies(settings, userId) {
  try {
    console.log('\n' + '='.repeat(60));
    console.log('🔍 Checking Gmail for new replies...');

    // Show which lead emails we're watching for
    await db.read();
    const userLeads = db.data.leads.filter(l => l.user_id === userId);
    console.log(`👥 Watching for replies from ${userLeads.length} leads:`);
    userLeads.forEach((lead, idx) => {
      console.log(`   ${idx + 1}. ${lead.email} ${lead.first_name ? `(${lead.first_name} ${lead.last_name})` : '(no name)'}`);
    });
    console.log('='.repeat(60));

    // Set up OAuth2 credentials
    oauth2Client.setCredentials({
      access_token: settings.access_token,
      refresh_token: settings.refresh_token,
      expiry_date: settings.token_expiry
    });

    // Refresh token if expired
    if (settings.token_expiry && settings.token_expiry < Date.now()) {
      console.log('🔄 Refreshing expired Gmail access token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Update stored tokens in database (FIX: Update the actual DB object!)
      await db.read();
      const dbSettings = db.data.email_settings.find(s => s.user_id === userId);
      if (dbSettings) {
        dbSettings.access_token = credentials.access_token;
        dbSettings.token_expiry = credentials.expiry_date;
        await db.write();
        console.log('✅ Refreshed tokens saved to database');
      }

      // Update local settings object too
      settings.access_token = credentials.access_token;
      settings.token_expiry = credentials.expiry_date;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Build query: only check emails FROM lead addresses (much more efficient)
    const leadEmails = userLeads.map(l => `from:${l.email}`).join(' OR ');
    const gmailQuery = `in:inbox newer_than:7d (${leadEmails})`;
    console.log(`🔍 Gmail query: checking emails from ${userLeads.length} leads`);

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: gmailQuery,
      maxResults: 50
    });

    const messages = response.data.messages || [];
    console.log(`📬 Found ${messages.length} unread messages`);

    const newReplies = [];

    for (const message of messages) {
      try {
        // Get full message details
        const fullMessage = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        // Parse email headers
        const headers = fullMessage.data.payload.headers;
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
        const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');

        // Extract email address from "Name <email@example.com>" format
        const rawFrom = fromHeader?.value;

        // Extract email using regex - handle both "Name <email>" and "email" formats
        let fromEmail = rawFrom;
        const emailMatch = rawFrom?.match(/<(.+?)>/);
        if (emailMatch) {
          fromEmail = emailMatch[1]; // Extract from angle brackets
        } else if (rawFrom) {
          fromEmail = rawFrom.match(/[\w\.-]+@[\w\.-]+\.\w+/)?.[0] || rawFrom;
        }

        const subject = subjectHeader?.value || '(No Subject)';

        // Get email body — recursively search all MIME parts (handles nested multipart/alternative)
        const findPart = (payload, mimeType) => {
          if (payload.mimeType === mimeType && payload.body?.data) return payload;
          if (payload.parts) {
            for (const part of payload.parts) {
              const found = findPart(part, mimeType);
              if (found) return found;
            }
          }
          return null;
        };
        let emailBody = '';
        const textPart = findPart(fullMessage.data.payload, 'text/plain');
        if (textPart) {
          emailBody = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        } else {
          // Fallback: extract text from HTML part
          const htmlPart = findPart(fullMessage.data.payload, 'text/html');
          if (htmlPart) {
            const html = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8');
            emailBody = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          } else if (fullMessage.data.payload.body?.data) {
            emailBody = Buffer.from(fullMessage.data.payload.body.data, 'base64').toString('utf-8');
          }
        }

        // Find matching lead
        await db.read();
        const lead = db.data.leads.find(l =>
          l.user_id === userId &&
          l.email.toLowerCase() === fromEmail.toLowerCase()
        );

        if (!lead) {
          console.log(`   ⏭️  SKIPPED: "${fromEmail}" is not a lead`);
          continue; // Skip to next message
        }

        // Check if this message has already been processed (prevent duplicates)
        const alreadyProcessed = db.data.email_threads.find(t =>
          t.gmail_message_id === message.id
        );

        if (alreadyProcessed) {
          console.log(`   ⏭️  Already processed message from ${lead.first_name}`);
          continue; // Skip to next message
        }

          console.log(`✉️  Processing reply from ${lead.first_name} (${fromEmail})`);

          // Analyze with AI (including subject line for better context)
          const analysis = await analyzeReplyWithAI(emailBody, subject);

          // Update lead — but don't overwrite INTERESTED with a vague GHOSTING reply.
          // Once a lead shows interest, keep them INTERESTED unless they explicitly decline.
          const prevIntentGmail = lead.ai_intent;
          const shouldUpdateIntentGmail = !(prevIntentGmail === 'INTERESTED' && analysis.intent === 'GHOSTING');
          if (shouldUpdateIntentGmail) {
            // If intent changed, reset follow-up counter so new rules apply fresh
            if (prevIntentGmail && prevIntentGmail !== analysis.intent) {
              lead.follow_up_count = 0;
            }
            lead.ai_intent = analysis.intent;
          }
          lead.ai_reasoning = analysis.reasoning;
          lead.last_reply = emailBody;
          lead.last_reply_date = new Date().toISOString();
          lead.last_subject = subject || '(No Subject)';
          lead.status = lead.ai_intent === 'INTERESTED' ? 'interested' : (lead.ai_intent === 'DEAD' ? 'dead' : 'analyzed');

          // AUTO-PAUSE SEQUENCE: Any reply means the sequence served its purpose.
          // Continuing to send sequence emails after a reply looks like spam.
          if (lead.enrolled_sequence_id && lead.sequence_completed === false && !lead.sequence_paused) {
            lead.sequence_paused = true;
            console.log(`⏸️ Sequence auto-paused for lead ${lead.id} — reply detected (${analysis.intent})`);
          }

          // AI LEARNING: If reply is positive, save the email that triggered it as a winning email
          if (['INTERESTED', 'NOT_NOW', 'OBJECTION'].includes(analysis.intent)) {
            const lastSent = (db.data.email_history || [])
              .filter(h => h.lead_id === lead.id)
              .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
            if (lastSent) {
              if (!db.data.winning_emails) db.data.winning_emails = [];
              // Cap at 50 winning emails per user (remove oldest if over limit)
              const userWinning = db.data.winning_emails.filter(w => w.user_id === userId);
              if (userWinning.length >= 50) {
                const oldest = userWinning[0];
                db.data.winning_emails = db.data.winning_emails.filter(w => w.id !== oldest.id);
              }
              db.data.winning_emails.push({
                id: (db.data.winning_emails.length || 0) + 1,
                user_id: userId,
                lead_id: lead.id,
                subject: lastSent.subject || '',
                body: lastSent.body || '',
                intent_triggered: analysis.intent,
                created_at: new Date().toISOString()
              });
              // Update A/B reply count for the variant that sent this email
              if (lastSent.ab_variant && db.data.ab_results) {
                const abRec = db.data.ab_results.find(r => r.user_id === userId && r.intent === (lead.ai_intent || 'GHOSTING'));
                if (abRec) {
                  if (lastSent.ab_variant === 'A') abRec.variant_a_replies++;
                  else abRec.variant_b_replies++;
                }
              }
              console.log(`🌟 Winning email saved for user ${userId} (triggered ${analysis.intent})`);
            }
          }

          // Store email thread with Gmail message ID for deduplication
          db.data.email_threads.push({
            id: db.data.email_threads.length + 1,
            gmail_message_id: message.id, // Store Gmail message ID to prevent duplicates
            lead_id: lead.id,
            user_id: userId,
            from: fromEmail,
            subject: subject,
            body: emailBody,
            received_at: new Date().toISOString(),
            ai_intent: analysis.intent,
            notified: false // Track if user has been notified about this email
          });

          await db.write();

          // ── AI Appointment Detection ──────────────────────────────────────
          // Detect if this email contains a confirmed/agreed appointment
          try {
            const aptDetected = await detectAppointmentFromEmail(emailBody, subject);
            if (aptDetected) {
              // Avoid duplicate: skip if same lead already has an AI-detected appointment on the same date+time
              const alreadyExists = (db.data.appointments || []).some(a =>
                a.lead_id === lead.id &&
                a.source === 'ai_detected' &&
                a.date === (aptDetected.date || '') &&
                a.time === (aptDetected.time || '')
              );
              if (!alreadyExists) {
                const newApt = {
                  id: Date.now(),
                  user_id: userId,
                  lead_id: lead.id,
                  date: aptDetected.date || '',
                  time: aptDetected.time || '',
                  timezone: aptDetected.timezone || 'UTC',
                  duration_minutes: 30,
                  meeting_link: '',
                  notes: aptDetected.notes || '',
                  appointment_type: aptDetected.appointment_type || 'call',
                  status: 'scheduled',
                  source: 'ai_detected',
                  notified: false,
                  outcome: null,
                  reminder_24h_sent: false,
                  reminder_1h_sent: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                };
                if (!db.data.appointments) db.data.appointments = [];
                db.data.appointments.push(newApt);
                // Update lead status
                const lIdx = db.data.leads.findIndex(l => l.id === lead.id);
                if (lIdx !== -1) {
                  db.data.leads[lIdx].status = 'appointment_scheduled';
                  db.data.leads[lIdx].updated_at = new Date().toISOString();
                }
                await db.write();
                console.log(`📅 AI detected appointment for ${lead.first_name}: type=${newApt.appointment_type}, date=${newApt.date}, time=${newApt.time}`);
              }
            }
          } catch (aptErr) {
            console.error('[Appointment Detection] Failed silently:', aptErr.message);
          }
          // ─────────────────────────────────────────────────────────────────

          // Generate AI response for ALL intents (reply to every customer message)
          // But first check if a draft already exists for this email thread to prevent duplicates
          const existingDraft = (db.data.ai_drafts || []).find(d =>
            d.lead_id === lead.id &&
            d.reply_subject === (subject || '') &&
            d.reply_text === emailBody &&
            d.status === 'pending'
          );

          let draft = null;
          let draftClarificationNeeded2 = false;

          if (!existingDraft) {
            // Only generate if no draft exists for this exact reply
            const aiResult2 = await generateAIResponse(lead, emailBody, analysis.intent, subject);
            if (aiResult2) {
              draft = aiResult2.body;
              draftClarificationNeeded2 = aiResult2.clarification_needed || false;

              // Increment AI generation counter for this user
              const uIdxGmail = db.data.users.findIndex(u => u.id === userId);
              if (uIdxGmail !== -1) {
                db.data.users[uIdxGmail].ai_generations_this_month =
                  (db.data.users[uIdxGmail].ai_generations_this_month || 0) + 1;
              }
            }
          } else {
            console.log(`⏭️  Draft already exists for this reply from ${lead.first_name} — skipping duplicate generation`);
            // Skip generating another draft for the same email
          }

          const user = db.data.users.find(u => u.id === userId);
          const isAutoMode = user && user.auto_mode_enabled;

          // Safety: never send blank emails
          if (draft && !draft.trim()) {
            console.log(`⚠️  Empty draft body for lead ${lead.id} (${lead.first_name}) — skipping send, saving as draft`);
            draft = null;
          }

          if (draft) {
            const shouldAutoSend = isAutoMode && lead.auto_send_enabled !== false;

            // If clarification needed AND we already sent a holding reply before → STOP auto-replying
            const alreadySentHolding = (lead.clarification_count || 0) >= 1;

            if (shouldAutoSend && draftClarificationNeeded2 && alreadySentHolding) {
              // STOP: Lead asked unanswered question again. Save draft, don't send.
              console.log(`🛑 STOPPED auto-reply for ${lead.first_name} — already sent holding reply. Same unanswered topic. Saving draft for manual follow-up.`);
              lead.clarification_count = (lead.clarification_count || 0) + 1;
              db.data.ai_drafts.push({
                id: db.data.ai_drafts.length + 1,
                lead_id: lead.id,
                user_id: userId,
                draft_body: draft,
                ai_intent: analysis.intent,
                reply_text: emailBody,
                reply_subject: subject || '',
                status: 'pending',
                clarification_needed: true,
                needs_follow_up: true,
                created_at: new Date().toISOString()
              });
              await db.write();

              newReplies.push({
                lead_id: lead.id,
                lead_name: `${lead.first_name} ${lead.last_name}`,
                intent: analysis.intent,
                draft_generated: true,
                needs_follow_up: true,
                auto_paused_clarification: true
              });
            } else if (shouldAutoSend) {
              // AUTO MODE: Send immediately
              try {
                const autoSendResult2 = await sendEmail(settings, lead.email, `Re: ${subject}`, draft, null, {
                  lead_id: lead.id
                });
                // Store sent email so future replies thread correctly
                if (!db.data.email_interactions) db.data.email_interactions = [];
                db.data.email_interactions.push({
                  id: db.data.email_interactions.length + 1,
                  lead_id: lead.id,
                  user_id: userId,
                  direction: 'sent',
                  subject: `Re: ${subject}`,
                  body: draft,
                  message_id: autoSendResult2.threading_message_id,
                  sent_at: new Date().toISOString()
                });
                console.log(`🚀 AUTO-SENT immediate reply to ${lead.first_name} (Intent: ${analysis.intent})${draftClarificationNeeded2 ? ' [HOLDING REPLY - needs follow-up]' : ''} - Auto Mode enabled`);
                lead.status = 'replied';
                lead.last_email_sent_date = new Date().toISOString(); // Reset follow-up timer from this reply

                if (draftClarificationNeeded2) {
                  lead.clarification_count = (lead.clarification_count || 0) + 1;
                  db.data.ai_drafts.push({
                    id: db.data.ai_drafts.length + 1,
                    lead_id: lead.id,
                    user_id: userId,
                    draft_body: draft,
                    ai_intent: analysis.intent,
                    reply_text: emailBody,
                    reply_subject: subject || '',
                    status: 'sent',
                    clarification_needed: true,
                    needs_follow_up: true,
                    created_at: new Date().toISOString(),
                    sent_at: new Date().toISOString()
                  });
                  console.log(`📋 Holding reply sent to ${lead.first_name} — flagged for your follow-up (question not in knowledge base)`);
                } else {
                  // Normal reply succeeded — reset clarification counter and resolve stale drafts
                  lead.clarification_count = 0;
                  resolveStaleActionRequiredDrafts(lead.id);
                }
                await db.write();

                newReplies.push({
                  lead_id: lead.id,
                  lead_name: `${lead.first_name} ${lead.last_name}`,
                  intent: analysis.intent,
                  draft_generated: false,
                  auto_sent: true,
                  needs_follow_up: draftClarificationNeeded2
                });
              } catch (sendError) {
                console.error(`❌ Failed to auto-send to ${lead.first_name}:`, sendError.message);
                db.data.ai_drafts.push({
                  id: db.data.ai_drafts.length + 1,
                  lead_id: lead.id,
                  user_id: userId,
                  draft_body: draft,
                  ai_intent: analysis.intent,
                  reply_text: emailBody,
                  reply_subject: subject || '',
                  status: 'pending',
                  clarification_needed: draftClarificationNeeded2,
                  created_at: new Date().toISOString()
                });
                await db.write();

                newReplies.push({
                  lead_id: lead.id,
                  lead_name: `${lead.first_name} ${lead.last_name}`,
                  intent: analysis.intent,
                  draft_generated: true,
                  auto_send_failed: true
                });
              }
            } else {
              // MANUAL MODE: Save as draft for user review
              if (draftClarificationNeeded2) {
                console.log(`⚠️  Clarification needed for lead ${lead.id} (${lead.first_name}) — question not in knowledge base. Draft saved for manual reply.`);
              }
              // Resolve stale Action Required drafts when a new correct reply is generated
              if (!draftClarificationNeeded2) {
                resolveStaleActionRequiredDrafts(lead.id);
              }
              db.data.ai_drafts.push({
                id: db.data.ai_drafts.length + 1,
                lead_id: lead.id,
                user_id: userId,
                draft_body: draft,
                ai_intent: analysis.intent,
                reply_text: emailBody,
                reply_subject: subject || '',
                status: 'pending',
                clarification_needed: draftClarificationNeeded2,
                created_at: new Date().toISOString()
              });
              await db.write();

              newReplies.push({
                lead_id: lead.id,
                lead_name: `${lead.first_name} ${lead.last_name}`,
                intent: analysis.intent,
                draft_generated: true,
                clarification_needed: draftClarificationNeeded2
              });
            }
          }

          // Try to mark as read (may fail if only gmail.readonly scope)
          try {
            await gmail.users.messages.modify({
              userId: 'me',
              id: message.id,
              requestBody: {
                removeLabelIds: ['UNREAD']
              }
            });
          } catch (readErr) {
            // Scope limitation - we track by gmail_message_id instead
          }

          console.log(`✅ Processed: ${lead.first_name} - Intent: ${analysis.intent}`);
      } catch (msgError) {
        console.error(`❌ Error processing message ${message.id}:`, msgError.message);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log(`✅ Email check complete!`);
    console.log(`   📬 Total unread messages: ${messages.length}`);
    console.log(`   ✨ New replies processed: ${newReplies.length}`);
    console.log(`   ⏭️  Skipped (not from leads): ${messages.length - newReplies.length}`);
    console.log('='.repeat(60) + '\n');

    return newReplies;
  } catch (error) {
    console.error('Gmail check error:', error);
    throw error;
  }
}

// ⚡ Gmail Push Notifications Setup (for instant email delivery)
async function setupGmailPushNotifications(settings, userId) {
  try {
    console.log(`\n🔔 Setting up Gmail Push Notifications for user ${userId}...`);

    // Set up OAuth2 credentials
    oauth2Client.setCredentials({
      access_token: settings.access_token,
      refresh_token: settings.refresh_token,
      expiry_date: settings.token_expiry
    });

    // Refresh token if expired
    if (settings.token_expiry && settings.token_expiry < Date.now()) {
      console.log('🔄 Refreshing Gmail access token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Update database
      await db.read();
      const dbSettings = db.data.email_settings.find(s => s.user_id === userId);
      if (dbSettings) {
        dbSettings.access_token = credentials.access_token;
        dbSettings.token_expiry = credentials.expiry_date;
        await db.write();
      }
      settings.access_token = credentials.access_token;
      settings.token_expiry = credentials.expiry_date;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/gmail-notifications`;

    // Watch Gmail inbox for new messages
    const response = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: topicName,
        labelIds: ['INBOX']
      }
    });

    console.log(`✅ Gmail Push Notifications ENABLED for user ${userId}`);
    console.log(`   Topic: ${topicName}`);
    console.log(`   Expiration: ${response.data.expiration}`);
    console.log(`   Emails will arrive within seconds (not 5 minutes!)`);

    // Update settings with watch info
    await db.read();
    const dbSettings = db.data.email_settings.find(s => s.user_id === userId);
    if (dbSettings) {
      dbSettings.push_enabled = true;
      dbSettings.push_setup_at = new Date().toISOString();
      dbSettings.push_history_id = response.data.historyId;
      await db.write();
    }

    return { success: true, expiration: response.data.expiration };
  } catch (error) {
    console.error(`❌ Failed to set up Gmail Push for user ${userId}:`, error.message);
    throw error;
  }
}

// AI Reply Analysis Function (Using Haiku - fast & cheap)
// Now includes subject line for better context
async function analyzeReplyWithAI(replyText, emailSubject = '') {
  try {
    const subjectLine = emailSubject ? `Subject: "${emailSubject}"\n` : '';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Analyze this email and classify the lead's intent. Reply ONLY with one of these exact words: INTERESTED, NOT_NOW, OBJECTION, GHOSTING, or DEAD.

Classification Rules (read carefully):
- INTERESTED: They want to engage — asking questions, requesting info, showing enthusiasm (e.g., "where is it?", "what is the price?", "I'm interested", "let's schedule", "can we talk?", "what is your name?", "tell me more", "how does it work?", "whatsapp?", "telegram?", "zoom?", "call?", "phone?")
- OBJECTION: They raise a concern, hesitation, or problem (e.g., "too expensive", "far from my home", "not sure if it fits", "concerned about distance")
- NOT_NOW: They explicitly say timing is wrong with time-based language (e.g., "not now", "maybe next month", "check back in Q2", "I'm busy until March") — MUST have timing words
- DEAD: Clear rejection (e.g., "not interested", "no thanks", "stop emailing", "don't contact me")
- GHOSTING: Vague responses with no clear meaning (e.g., "thanks", "ok", "noted", "sure") — only when none of the above apply

IMPORTANT: Use BOTH subject and body to determine intent — the subject alone can reveal if the lead is asking a question.
IMPORTANT: Distance/location concerns = OBJECTION, NOT NOT_NOW. Questions about anything = INTERESTED.
IMPORTANT: Any message ending with '?' = INTERESTED — the lead is asking a question regardless of how short it is.
IMPORTANT: Any message mentioning a communication platform or contact method (whatsapp, telegram, signal, viber, zoom, teams, phone, call) = INTERESTED — the lead wants to connect.
IMPORTANT: If both subject and body are blank = GHOSTING.

${subjectLine}Body: "${replyText}"

Classification:`
        }]
      })
    });

    if (response.ok) {
      const data = await response.json();
      const raw = data.content[0].text.trim().toUpperCase();
      console.log(`[CLAUDE API] Raw response: "${raw.substring(0, 100)}"`);

      // Extract just the first valid classification word
      const validIntents = ['INTERESTED', 'NOT_NOW', 'OBJECTION', 'GHOSTING', 'DEAD'];
      const found = validIntents.find(v =>
        raw === v ||
        raw.startsWith(v + ' ') ||
        raw.startsWith(v + '\n') ||
        raw.includes('\n' + v) ||
        raw.includes(': ' + v) ||
        raw.includes(' ' + v + '\n') ||
        raw.includes('\n\n' + v)
      );
      const intent = found || 'GHOSTING';
      console.log(`[CLASSIFICATION] Intent: ${intent}`);

      const reasoning = {
        'INTERESTED': 'Lead shows engagement and buying interest',
        'NOT_NOW': 'Lead indicates timing is not right with explicit timeframe',
        'OBJECTION': 'Lead raises concerns or hesitations',
        'GHOSTING': 'Generic or unclear response',
        'DEAD': 'Lead explicitly rejects'
      };

      return {
        intent,
        reasoning: reasoning[intent] || 'Unable to classify'
      };
    }
  } catch (error) {
    console.error('AI analysis error:', error);
  }

  // Fallback keyword-based classification (checks both body and subject)
  console.log(`[FALLBACK CLASSIFICATION] Using keyword detection for: "${replyText.substring(0, 50)}"`);
  const lower = (replyText + ' ' + emailSubject).toLowerCase();

  // Check INTERESTED first
  if (lower.includes('interested') || lower.includes('yes') || lower.includes('sounds good') ||
      lower.includes('schedule') || lower.includes('call me') || lower.includes("let's talk") ||
      lower.includes('where is') || lower.includes('what is the') || lower.includes('how much') ||
      lower.includes('more info') || lower.includes('tell me more') ||
      // Question = asking something = INTERESTED
      lower.trim().endsWith('?') ||
      // Communication platform / contact method names = wants to connect
      lower.includes('whatsapp') || lower.includes('telegram') || lower.includes('signal') ||
      lower.includes('viber') || lower.includes('zoom') || lower.includes(' teams') ||
      lower.includes('google meet') || lower.includes('phone number') || lower.includes('mobile')) {
    console.log('[FALLBACK] → INTERESTED');
    return { intent: 'INTERESTED', reasoning: 'Keyword: shows engagement' };
  }

  // Check DEAD
  if (lower.includes('not interested') || lower.includes('no thanks') || lower.includes('unsubscribe') ||
      lower.includes('stop emailing') || lower.includes('dont contact')) {
    console.log('[FALLBACK] → DEAD');
    return { intent: 'DEAD', reasoning: 'Keyword: clear rejection' };
  }

  // Check OBJECTION (before NOT_NOW - more specific)
  if (lower.includes('but ') || lower.includes('however') || lower.includes('concern') ||
      lower.includes('expensive') || lower.includes('not sure') || lower.includes('far from') ||
      lower.includes('too far') || lower.includes('distance') || lower.includes('location') ||
      lower.includes('inconvenient') || lower.includes('accessible') || lower.includes('price seems')) {
    console.log('[FALLBACK] → OBJECTION');
    return { intent: 'OBJECTION', reasoning: 'Keyword: raises objection/concern' };
  }

  // Check NOT_NOW (requires timing keywords)
  if ((lower.includes('later') || lower.includes('next month') || lower.includes('next quarter') ||
       lower.includes('not now') || lower.includes('busy until') || lower.includes('check back')) &&
      !lower.includes('interested')) {
    console.log('[FALLBACK] → NOT_NOW');
    return { intent: 'NOT_NOW', reasoning: 'Keyword: timing-based delay' };
  }

  console.log('[FALLBACK] → GHOSTING');
  return { intent: 'GHOSTING', reasoning: 'No clear signals detected' };
}

// ─── Appointment Detection ─────────────────────────────────────────────────────
async function detectAppointmentFromEmail(emailBody, subject) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are an appointment detection assistant. Analyze this email to determine if an appointment, meeting, call, or viewing has been CONFIRMED or AGREED UPON (not just requested).

Subject: "${subject || ''}"
Email: "${emailBody}"

If an appointment IS confirmed/scheduled/agreed upon, return ONLY this JSON:
{"appointment_detected":true,"date":"YYYY-MM-DD or null","time":"HH:MM 24h or null","timezone":"timezone name or null","appointment_type":"call|meeting|video_call|property_showing|demo|other","notes":"1-sentence context about the appointment"}

If NO appointment is confirmed, return ONLY:
{"appointment_detected":false}

Return ONLY valid JSON. No explanation.`
        }]
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    const text = data.content[0].text.trim();
    // Strip possible markdown code fences
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const result = JSON.parse(jsonText);
    if (!result.appointment_detected) return null;
    return result;
  } catch (e) {
    console.error('[Appointment Detection] Error:', e.message);
    return null;
  }
}

function getBusinessTypeContext(businessType) {
  const contexts = {
    real_estate: 'BUSINESS TYPE: Real Estate / Property. Help the lead find properties that match their needs. Respect their location/distance preferences — never push aggressively if they say a property is too far.',
    insurance:   'BUSINESS TYPE: Insurance. Your goal is to schedule a consultation call to discuss coverage options. Never quote prices via email.',
    saas:        'BUSINESS TYPE: SaaS / Software App. Do NOT push for appointments or meetings. Answer product questions and direct the lead to a free trial or product demo. Keep it low-pressure.',
    ecommerce:   'BUSINESS TYPE: E-commerce / Online Store. No appointments needed. Provide product info, handle concerns, and link to the product page.',
    consulting:  'BUSINESS TYPE: Consulting Services. Your goal is to schedule a 30-minute discovery call to understand the lead\'s challenges.',
    community:   'BUSINESS TYPE: Community / Social Platform. No appointments needed. Answer FAQs and invite the lead to join or try for free.',
    other:       ''
  };
  return contexts[businessType] || '';
}

function getCustomInstructionsContext(customInstructions) {
  if (!customInstructions || !customInstructions.trim()) return '';
  return `CUSTOM INSTRUCTIONS (follow these exactly):\n${customInstructions.trim()}`;
}

function getBusinessKnowledgeContext(businessKnowledge, liveUpdates) {
  const parts = [];
  if (businessKnowledge && businessKnowledge.trim()) {
    parts.push(`BUSINESS KNOWLEDGE (stable product/service details, policies, FAQs — use as factual reference):\n${businessKnowledge.trim()}`);
  }
  if (liveUpdates && liveUpdates.trim()) {
    parts.push(`LIVE UPDATES (current availability, promotions, stock — treat as the latest facts):\n${liveUpdates.trim()}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : '';
}

function getSellerContext(sellerProfile) {
  if (!sellerProfile) return '';
  const lines = [];
  if (sellerProfile.seller_name)    lines.push(`- Your Name: ${sellerProfile.seller_name}`);
  if (sellerProfile.seller_company) lines.push(`- Your Company: ${sellerProfile.seller_company}`);
  if (sellerProfile.seller_email)   lines.push(`- Your Reply-To Email: ${sellerProfile.seller_email}`);
  if (sellerProfile.seller_phone)   lines.push(`- Your Phone: ${sellerProfile.seller_phone}`);
  if (sellerProfile.seller_website) lines.push(`- Your Website: ${sellerProfile.seller_website}`);
  if (sellerProfile.seller_social)  lines.push(`- Your Social / Booking: ${sellerProfile.seller_social}`);

  // Auto-build signature from name + company + phone so user doesn't need to write one manually
  const sigParts = [sellerProfile.seller_name, sellerProfile.seller_company, sellerProfile.seller_phone].filter(Boolean);
  if (sigParts.length > 0) lines.push(`- Sign off the email with:\nBest regards,\n${sigParts.join(' | ')}`);

  if (lines.length === 0) return '';
  return `\nSELLER CONTACT INFORMATION (use ONLY these details whenever you mention any contact info, name, phone, website, email, or signature):\n${lines.join('\n')}`;
}

const SELLER_GUARDRAIL = `\n\n⚠️ IMPORTANT RULE: NEVER use phone numbers, email addresses, personal names, website URLs, social media handles, booking links, or any other contact information that may appear inside the product description or knowledge base. Those may belong to a third-party source. Use ONLY the SELLER CONTACT INFORMATION block above for any contact details. If no seller contact info is provided, leave contact details blank or use a generic placeholder like [Your Name].`;

// Helper: Detect if this lead has raised an objection before (any type, any business)
function hasRepeatedObjection(lead) {
  if (!lead) return false;

  // Method 1: Check if lead previously had OBJECTION intent classified
  // (stored on the lead record from a prior analysis)
  if (lead.previous_objection_count && lead.previous_objection_count >= 1) {
    return true;
  }

  // Method 2: Check email_interactions history for previous OBJECTION classifications
  if (db.data.email_interactions) {
    const previousObjInteractions = db.data.email_interactions.filter(i =>
      i.lead_id === lead.id &&
      i.direction === 'received' &&
      i.ai_intent === 'OBJECTION'
    );
    if (previousObjInteractions.length >= 1) return true;
  }

  // Method 3: Check ai_drafts — if a previous OBJECTION draft was generated, concern was raised before
  if (db.data.ai_drafts) {
    const previousObjDrafts = db.data.ai_drafts.filter(d =>
      d.lead_id === lead.id &&
      d.ai_intent === 'OBJECTION'
    );
    if (previousObjDrafts.length >= 1) return true;
  }

  return false;
}

// When a correct (non-holding) reply is generated for a lead, resolve any old stale
// Action Required drafts so the lead no longer appears in the Action Required queue.
function resolveStaleActionRequiredDrafts(leadId) {
  db.data.ai_drafts.forEach(d => {
    if (d.lead_id === leadId && d.status === 'pending' && (d.needs_follow_up || d.clarification_needed)) {
      d.status = 'resolved';
      console.log(`🧹 Resolved stale Action Required draft #${d.id} for lead ${leadId} — new correct reply generated`);
    }
  });
}

// AI Response Generation (Using Sonnet - better quality, only for INTERESTED/OBJECTION)
async function generateAIResponse(lead, originalReply, intent, emailSubject = '') {

  // Load product profile for this user so AI replies are grounded in their real offering
  await db.read();
  const productProfile = db.data.product_profiles.find(p => p.user_id === lead.user_id);
  const user = db.data.users.find(u => u.id === lead.user_id);

  // Check if required product fields are filled in
  const hasProductInfo = productProfile &&
    (productProfile.product_name || '').trim() &&
    (productProfile.product_description || '').trim() &&
    ((productProfile.key_benefits || '').trim() || (productProfile.unique_selling_points || '').trim());

  // If customer is asking about the product (INTERESTED/OBJECTION) and product info is missing,
  // trigger clarification mode — don't make anything up
  if (!hasProductInfo && (intent === 'INTERESTED' || intent === 'OBJECTION')) {
    const clarificationBody = `Hi ${lead.first_name},\n\nThank you for your question.\n\nI want to make sure I give you accurate information. Let me confirm the details and get back to you shortly.\n\nBest regards`;
    return { body: clarificationBody, clarification_needed: true };
  }

  const sellerProfile = db.data.seller_profiles.find(p => p.user_id === lead.user_id);
  const sellerContext = getSellerContext(sellerProfile);

  const ctaText = (productProfile?.call_to_action || '').trim();
  const productContext = productProfile
    ? `You are a sales rep for the following business (use these for product facts ONLY — do NOT copy any contact details from here):
Product/Service: ${productProfile.product_name || ''}
Description: ${productProfile.product_description || ''}
Key Benefits: ${productProfile.key_benefits || ''}
Target Audience: ${productProfile.target_audience || ''}
Unique Selling Points: ${productProfile.unique_selling_points || ''}
${ctaText ? `Call to Action: ${ctaText}` : ''}
${productProfile.special_offers ? `Special Offer: ${productProfile.special_offers}` : ''}
${productProfile.success_stories ? `Success Story: ${productProfile.success_stories}` : ''}`
    : `You are a helpful sales rep.`;

  const businessTypeContext = getBusinessTypeContext(user?.business_type || 'other');
  const businessKnowledgeContext = getBusinessKnowledgeContext(user?.business_knowledge || '', user?.live_updates || '');
  const customInstructionsContext = getCustomInstructionsContext(user?.ai_custom_instructions || '');

  const subjectContext = emailSubject ? `\nEmail Subject: "${emailSubject}"` : '';

  // Detect if this is a repeated objection (same concern raised before)
  const isRepeatedObjection = intent === 'OBJECTION' && hasRepeatedObjection(lead);

  const clarificationRule = intent === 'INTERESTED'
    ? `\n\n⚠️ RULE FOR INTERESTED LEADS — HANDLING MISSING SPECIFIC DETAILS:
If the customer asks for specific details (e.g. exact price, availability, specific unit info) that are NOT listed in your knowledge above, but you DO have general knowledge about the product/property they are asking about:
1. Respond with the details you DO know — highlight the property/product features, benefits, and location
2. For missing specifics like price: acknowledge their question warmly and invite them to schedule a viewing or call where full pricing and details can be discussed in person
3. Do NOT add [NEEDS_CLARIFICATION] — always give an engaging, helpful reply to interested leads
4. Only add [NEEDS_CLARIFICATION] if the customer is asking about a COMPLETELY DIFFERENT product, property, or location that you have ZERO information about

Example — customer asks "how much is the price?":
CORRECT: "Hi [Name], great question! The [property name] is [key features]. It's a fantastic fit for [target audience/benefits]. I'd love to schedule a viewing so we can walk through the property and go over pricing in detail — when are you free?"
WRONG: "Let me check on the pricing and get back to you shortly." ← Never send a holding reply when you have product knowledge.`
    : `\n\n⚠️ HIGHEST PRIORITY RULE — OVERRIDES ALL OTHER INSTRUCTIONS:
If the customer asks about something NOT covered in your product/business knowledge above (e.g. different products, pricing you don't have, alternative options, availability, specific details not mentioned), you MUST:
1. Do NOT try to sell or pitch your existing product instead
2. Do NOT redirect them to a call/demo as a workaround
3. Do NOT pretend you can help when you don't have the info
4. ONLY write a short, honest holding reply (max 50 words) that:
   - Acknowledges EXACTLY what they asked about (e.g. "apartments below 300k in Kajang")
   - Says you'll check on it and get back to them shortly
   - Keeps it warm and brief
5. Add the exact tag [NEEDS_CLARIFICATION] at the very end (after sign-off)

Example of CORRECT holding reply:
"Hi John, great question about apartments below 300k in Kajang! Let me check what options are available in that range and I'll get back to you shortly. Best regards"

Example of WRONG reply (do NOT do this):
"I specialize in landed homes... would you like a call?" ← This ignores their question and pushes your product instead.`;

  const intentInstructions = {
    INTERESTED: `The lead ${lead.first_name} from ${lead.company || 'their company'} is INTERESTED and replied:${subjectContext}\nReply: "${originalReply}"\n\nWrite a short, warm follow-up email (max 100 words) to book the next step (demo/call). Reference specific details from your product/service above. Do NOT use placeholder text like [Your Name].`,
    OBJECTION: `The lead ${lead.first_name} from ${lead.company || 'their company'} raised an objection:${subjectContext}\nReply: "${originalReply}"\n\nWrite a professional email (max 100 words) with this approach:
1. ACKNOWLEDGE - Acknowledge the concern calmly
2. VALUE CLARIFY - Provide ONE concise value clarification (do not defend repeatedly)
3. FORWARD QUESTION - Ask one forward-moving question
4. DO NOT push for viewing immediately${isRepeatedObjection ? '\n\nNOTE: This objection has been raised before. Reduce persuasion, offer alternatives gracefully, and be willing to accept their preference.' : ''}

Tone: Calm, Confident, Professional, Not defensive, Not needy.
Do NOT use placeholder text like [Your Name].`,
    GHOSTING: `The lead ${lead.first_name} from ${lead.company || 'their company'} sent a short or unclear message:${subjectContext}\nReply: "${originalReply}"\n\nWrite a brief, friendly reply (max 80 words) that warmly acknowledges their message and re-opens the conversation with one simple open-ended question to understand what they need. Do NOT use placeholder text like [Your Name].`,
    NOT_NOW: `The lead ${lead.first_name} from ${lead.company || 'their company'} indicated the timing is not right:${subjectContext}\nReply: "${originalReply}"\n\nWrite a short, respectful reply (max 80 words) that acknowledges their timing, briefly reminds them of the key value, and offers to reconnect when they are ready. Keep it warm and pressure-free. Do NOT use placeholder text like [Your Name].`,
    DEAD: `The lead ${lead.first_name} from ${lead.company || 'their company'} has indicated they are not interested:${subjectContext}\nReply: "${originalReply}"\n\nWrite a very brief, graceful closing reply (max 60 words) that respects their decision, thanks them for their time, and leaves the door open in case they change their mind in the future. No pressure at all. Do NOT use placeholder text like [Your Name].`
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `${productContext}${sellerContext}${businessTypeContext ? '\n\n' + businessTypeContext : ''}${businessKnowledgeContext ? '\n\n' + businessKnowledgeContext : ''}${customInstructionsContext ? '\n\n' + customInstructionsContext : ''}${SELLER_GUARDRAIL}${clarificationRule}\n\n---\n\n${intentInstructions[intent]}\n\nWrite ONLY the email body (no subject line). Keep it under 100 words.\n\nEmail:`
        }]
      })
    });

    if (response.ok) {
      const data = await response.json();
      let aiBody = data.content[0].text.trim();

      // Detect if AI flagged this as needing clarification
      let needsClarification = aiBody.includes('[NEEDS_CLARIFICATION]');
      aiBody = aiBody.replace(/\[NEEDS_CLARIFICATION\]/g, '').trim();

      // Safety: never return empty body — use holding message as fallback
      if (!aiBody) {
        console.log(`⚠️  AI returned empty body for lead ${lead.id} (${lead.first_name}) — using holding reply`);
        aiBody = `Hi ${lead.first_name},\n\nThank you for reaching out! That's a great question.\n\nLet me look into this and get back to you with the right information shortly.\n\nBest regards`;
        // INTERESTED leads with product knowledge should never trigger Action Required
        return { body: aiBody, clarification_needed: intent === 'INTERESTED' && hasProductInfo ? false : true };
      }

      // INTERESTED leads with product knowledge should always get a direct reply.
      // Even if the AI added [NEEDS_CLARIFICATION] (e.g. missing a specific price),
      // override it — the AI's reply already shares what it knows and invites a discussion.
      if (intent === 'INTERESTED' && hasProductInfo && needsClarification) {
        console.log(`ℹ️  INTERESTED lead with product knowledge — overriding clarification flag (AI will share available info + invite viewing)`);
        needsClarification = false;
      }

      if (needsClarification) {
        console.log(`⚠️  AI flagged clarification needed for lead ${lead.id} (${lead.first_name}) — question not covered by knowledge base`);
      }

      return { body: aiBody, clarification_needed: needsClarification };
    } else {
      console.error('AI response error:', response.status, await response.text());
    }
  } catch (error) {
    console.error('AI generation error:', error);
  }

  // Fallback using product knowledge if AI call fails
  const cta = productProfile?.call_to_action || 'book a quick call';
  if (intent === 'NOT_NOW') {
    return { body: `Hi ${lead.first_name},\n\nNo problem at all — I completely understand timing matters. I'll follow up with you when the time is right.\n\nFeel free to reach out whenever you're ready.\n\nBest regards`, clarification_needed: false };
  }
  if (intent === 'GHOSTING') {
    return { body: `Hi ${lead.first_name},\n\nThanks for getting back to me! Just wanted to check in — what questions do you have that I can help with?\n\nBest regards`, clarification_needed: false };
  }
  if (intent === 'OBJECTION') {
    if (isRepeatedObjection) {
      return { body: `Hi ${lead.first_name},\n\nI understand — your concern is important. If this is a dealbreaker for you, that's okay. I'm happy to explore alternatives or help you find a better fit.\n\nLet me know how I can help.\n\nBest regards`, clarification_needed: false };
    }
    return { body: `Hi ${lead.first_name},\n\nI hear your concern. Here's what I think might matter: [brief value point]\n\nWhat's most important to you in this situation?\n\nLooking forward to your thoughts.\n\nBest regards`, clarification_needed: false };
  }
  return { body: `Hi ${lead.first_name},\n\nThank you for getting back to me! I'd love to ${cta} to show you exactly how we can help${lead.company ? ` ${lead.company}` : ''}.\n\nWhen works best for you this week?\n\nBest regards`, clarification_needed: false };
}

/**
 * Send Email via Gmail OAuth with Email Threading Support
 *
 * EMAIL THREADING FEATURE:
 * When you send multiple follow-up emails to the same customer, they now appear
 * in the SAME email thread instead of separate conversations.
 *
 * HOW IT WORKS:
 * 1. First email sent → Generated with unique Message-ID: <timestamp-random@domain.com>
 *    This Message-ID is stored in the email_interactions table
 *
 * 2. Second email sent → Looks up the first email's Message-ID from database
 *    Then adds threading headers:
 *    - In-Reply-To: <first-email-message-id>
 *    - References: <first-email-message-id> <second-email-message-id>
 *    This tells Gmail/Outlook to group them in the same thread
 *
 * 3. RESULT: Customer sees:
 *    Email 1: "Your question about..."
 *    └─ Email 2 (threaded): "Re: Your question about..." (appears as follow-up)
 *
 * REQUIREMENTS:
 * - Pass options.lead_id to enable threading lookups
 * - Email interactions must store the message_id field
 */
async function sendEmail(settings, to, subject, body, senderName = null, options = {}) {
  // Gmail OAuth ONLY - no Resend
  if (!settings.provider || settings.provider !== 'gmail') {
    throw new Error('❌ Gmail OAuth not configured. Please connect Gmail in Settings.');
  }

  if (!settings.access_token || !settings.refresh_token) {
    throw new Error('❌ Gmail tokens missing. Please reconnect Gmail in Settings.');
  }

  // Check if token was marked as invalid by background refresh job
  if (settings.token_invalid) {
    throw new Error('Gmail authentication expired. Please DISCONNECT and RECONNECT Gmail in Settings.');
  }

  try {
    // Set up OAuth2 credentials
    oauth2Client.setCredentials({
      access_token: settings.access_token,
      refresh_token: settings.refresh_token,
      expiry_date: settings.token_expiry
    });

    // Check if token is expired and refresh if needed
    if (settings.token_expiry && settings.token_expiry < Date.now()) {
      console.log('🔄 Refreshing expired Gmail access token...');
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Update stored tokens in database (FIX: Update the actual DB object!)
      await db.read();  // Read latest data
      const dbSettings = db.data.email_settings.find(s => s.email === settings.email);
      if (dbSettings) {
        dbSettings.access_token = credentials.access_token;
        dbSettings.token_expiry = credentials.expiry_date;
        await db.write();
        console.log('✅ Refreshed tokens saved to database');
      }

      // Update local settings object too
      settings.access_token = credentials.access_token;
      settings.token_expiry = credentials.expiry_date;
    }

    // Use Gmail API directly (more reliable than nodemailer OAuth2)
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Build email content
    const displayName = senderName || settings.email.split('@')[0];
    const htmlContent = options.html || body.replace(/\n/g, '<br>');
    const attachments = options.attachments || [];

    // EMAIL THREADING: Generate unique Message-ID for this email
    const messageId = `<${Date.now()}-${Math.random().toString(36).substring(2, 9)}@${settings.email.split('@')[1]}>`;

    // Look up previous emails to the same recipient for threading
    let inReplyTo = null;
    let references = null;

    if (options.lead_id) {
      const previousEmails = db.data.email_interactions?.filter(
        e => e.lead_id === options.lead_id && e.direction === 'sent' && e.message_id
      ) || [];

      // Get the most recent previous email
      if (previousEmails.length > 0) {
        const lastEmail = previousEmails[previousEmails.length - 1];
        inReplyTo = lastEmail.message_id;
        // Build references chain (all previous message IDs)
        references = previousEmails.map(e => e.message_id).join(' ');

        console.log(`🔗 Threading: This email is replying to ${lastEmail.message_id}`);
      }
    }

    // Create MIME email message with threading headers
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;

    let message;
    if (attachments.length > 0) {
      // Multipart MIME for attachments
      const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const parts = [
        `From: ${displayName} <${settings.email}>`,
        `To: ${to}`,
        `Subject: ${utf8Subject}`,
        `Message-ID: ${messageId}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
        references ? `References: ${references} ${messageId}` : null,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlContent).toString('base64')
      ].filter(v => v !== null); // Remove null threading headers but keep empty string MIME separator

      for (const att of attachments) {
        if (!att.content) continue;
        parts.push(`--${boundary}`);
        parts.push(`Content-Type: ${att.content_type || 'application/octet-stream'}; name="${att.filename}"`);
        parts.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        parts.push('Content-Transfer-Encoding: base64');
        parts.push('');
        // att.content is already base64
        parts.push(att.content);
      }
      parts.push(`--${boundary}--`);
      message = parts.join('\r\n');
    } else {
      // Simple text/html message (base64 encoded body to prevent MIME corruption)
      const messageParts = [
        `From: ${displayName} <${settings.email}>`,
        `To: ${to}`,
        `Subject: ${utf8Subject}`,
        `Message-ID: ${messageId}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
        references ? `References: ${references} ${messageId}` : null,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlContent).toString('base64')
      ].filter(v => v !== null); // Remove null threading headers but keep empty string MIME separator
      message = messageParts.join('\r\n');
    }

    // Encode message in base64url format
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Send via Gmail API
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    console.log(`✅ Email sent via Gmail API to ${to} (messageId: ${messageId})`);

    // Return both the Gmail API result and our threading Message-ID for storage
    return {
      ...result.data,
      threading_message_id: messageId
    };
  } catch (error) {
    console.error('❌ Failed to send email via Gmail:', error.message);

    // Check if it's an authentication error
    if (error.message.includes('invalid_grant') ||
        error.message.includes('Token') ||
        error.message.includes('credentials') ||
        error.code === 401 ||
        error.response?.data?.error === 'invalid_grant') {
      throw new Error('Gmail authentication expired. Please DISCONNECT and RECONNECT Gmail in Settings.');
    }

    throw new Error(`Gmail send failed: ${error.message}`);
  }
}

// Get AI Drafts (for user review)
app.get('/api/drafts', authenticate, async (req, res) => {
  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);
  const isAutoMode = user && user.auto_mode_enabled;

  let userDrafts = [];

  if (isAutoMode) {
    // Auto mode: only show drafts that NEED human follow-up (AI couldn't answer)
    userDrafts = db.data.ai_drafts
      .filter(d => d.user_id === req.userId && (d.needs_follow_up === true || d.clarification_needed === true) && d.status === 'pending')
      .map(draft => {
        const lead = db.data.leads.find(l => l.id === draft.lead_id);
        return {
          ...draft,
          lead_name: `${lead.first_name} ${lead.last_name}`,
          lead_email: lead.email,
          lead_company: lead.company
        };
      });
  } else {
    // Manual mode: only show drafts that need human input (AI couldn't answer).
    // Correctly generated AI drafts are visible inside each lead's detail view —
    // they do NOT belong in "Action Required" since the AI already handled them.
    userDrafts = db.data.ai_drafts
      .filter(d => d.user_id === req.userId && d.status === 'pending' && (d.needs_follow_up === true || d.clarification_needed === true))
      .map(draft => {
        const lead = db.data.leads.find(l => l.id === draft.lead_id);
        return {
          ...draft,
          lead_name: `${lead.first_name} ${lead.last_name}`,
          lead_email: lead.email,
          lead_company: lead.company
        };
      });
  }

  res.json({ drafts: userDrafts });
});

// Regenerate AI Draft (user didn't like the previous AI reply)
app.post('/api/drafts/:id/regenerate', authenticate, async (req, res) => {
  await db.read();

  const draft = db.data.ai_drafts.find(d => d.id === parseInt(req.params.id) && d.user_id === req.userId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const lead = db.data.leads.find(l => l.id === draft.lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const userForCheck = db.data.users.find(u => u.id === req.userId);
  if (!isPlanActive(userForCheck)) {
    return res.status(402).json({ error: 'plan_expired', message: 'Your free trial has expired. Please upgrade to continue.', upgrade_url: '/billing' });
  }
  await resetMonthlyCounterIfNeeded(userForCheck);
  const { limits: genLimits } = getUserPlan(userForCheck);
  if ((userForCheck.ai_generations_this_month || 0) >= genLimits.ai_generations_limit) {
    return res.status(402).json({ error: 'ai_limit_reached', message: `You've used all ${genLimits.ai_generations_limit} AI generations for this month. Upgrade your plan for more.`, upgrade_url: '/billing' });
  }

  try {
    const aiResult = await generateAIResponse(lead, draft.reply_text || '', draft.ai_intent || 'INTERESTED', draft.reply_subject || '');
    const newBody = aiResult.body;

    // Update the draft body in DB
    const draftIdx = db.data.ai_drafts.findIndex(d => d.id === draft.id);
    if (draftIdx !== -1) {
      db.data.ai_drafts[draftIdx].draft_body = newBody;
    }

    // Increment AI generation counter
    const uIdx = db.data.users.findIndex(u => u.id === req.userId);
    if (uIdx !== -1) {
      db.data.users[uIdx].ai_generations_this_month = (db.data.users[uIdx].ai_generations_this_month || 0) + 1;
    }

    await db.write();

    res.json({ draft_body: newBody });
  } catch (error) {
    console.error('Draft regenerate error:', error);
    res.status(500).json({ error: 'Failed to regenerate draft' });
  }
});

// Approve and Send Draft
app.post('/api/drafts/:id/send', authenticate, async (req, res) => {
  const { edited_body, knowledge_update } = req.body;

  await db.read();

  const draft = db.data.ai_drafts.find(d => d.id === parseInt(req.params.id) && d.user_id === req.userId);
  const settings = db.data.email_settings.find(s => s.user_id === req.userId);
  const lead = db.data.leads.find(l => l.id === draft.lead_id);

  if (!draft || !settings || !lead) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const bodyToSend = edited_body || draft.draft_body;
    // Use the customer's original email subject for proper threading context
    const emailSubject = lead.last_subject ? `Re: ${lead.last_subject.replace(/^Re:\s*/i, '')}` : 'Re: Following up';
    const sendResult = await sendEmail(settings, lead.email, emailSubject, bodyToSend, null, {
      lead_id: lead.id
    });

    // Store sent email in email_interactions so future replies thread correctly
    if (!db.data.email_interactions) db.data.email_interactions = [];
    db.data.email_interactions.push({
      id: db.data.email_interactions.length + 1,
      lead_id: lead.id,
      user_id: req.userId,
      direction: 'sent',
      subject: emailSubject,
      body: bodyToSend,
      message_id: sendResult.threading_message_id,
      sent_at: new Date().toISOString()
    });

    draft.status = 'sent';
    draft.sent_at = new Date().toISOString();
    draft.final_body = bodyToSend;
    lead.status = 'replied';
    const draftSender = db.data.users.find(u => u.id === req.userId);
    lead.ai_paused_by_human = false; // AI continues to follow up even after manual draft send
    lead.last_email_sender = 'human';
    lead.clarification_count = 0; // Human replied — reset clarification counter, AI can resume

    // If user provided knowledge update, append it to their business_knowledge
    if (knowledge_update && knowledge_update.trim()) {
      const user = db.data.users.find(u => u.id === req.userId);
      if (user) {
        const existing = (user.business_knowledge || '').trim();
        const timestamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        user.business_knowledge = existing
          ? `${existing}\n\n[Added ${timestamp}]: ${knowledge_update.trim()}`
          : `[Added ${timestamp}]: ${knowledge_update.trim()}`;
        console.log(`📚 Knowledge base updated for user ${req.userId}`);
      }
    }

    await db.write();

    res.json({ success: true, knowledge_saved: !!(knowledge_update && knowledge_update.trim()) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject Draft
app.post('/api/drafts/:id/reject', authenticate, async (req, res) => {
  await db.read();

  const draft = db.data.ai_drafts.find(d => d.id === parseInt(req.params.id) && d.user_id === req.userId);

  if (draft) {
    draft.status = 'rejected';
    await db.write();
  }

  res.json({ success: true });
});

// Bulk Auto-Send Pending Drafts (when user enables auto mode with pending drafts)
app.post('/api/drafts/bulk-send', authenticate, async (req, res) => {
  const { send_all } = req.body; // If true, send all pending drafts

  await db.read();

  const user = db.data.users.find(u => u.id === req.userId);
  const settings = db.data.email_settings.find(s => s.user_id === req.userId);

  if (!settings || settings.provider !== 'gmail') {
    return res.status(400).json({ error: 'Email not configured' });
  }

  const pendingDrafts = db.data.ai_drafts.filter(
    d => d.user_id === req.userId && d.status === 'pending'
  );

  if (!send_all) {
    // Just return count for confirmation
    return res.json({
      pending_count: pendingDrafts.length,
      drafts: pendingDrafts.map(d => ({
        id: d.id,
        lead_id: d.lead_id,
        ai_intent: d.ai_intent
      }))
    });
  }

  // Send all pending drafts
  const results = {
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: []
  };

  for (const draft of pendingDrafts) {
    const lead = db.data.leads.find(l => l.id === draft.lead_id);

    if (!lead) {
      results.failed++;
      continue;
    }

    // Respect objection safety (don't auto-send objections unless explicitly enabled)
    if (draft.ai_intent === 'OBJECTION' && !user.auto_mode_include_objections) {
      results.skipped++; // Skip objections for manual review
      continue;
    }

    try {
      await sendEmail(settings, lead.email, 'Re: Following up', draft.draft_body, null, {
        lead_id: lead.id
      });

      draft.status = 'sent';
      draft.sent_at = new Date().toISOString();
      draft.final_body = draft.draft_body;
      lead.status = 'replied';

      results.sent++;
    } catch (error) {
      console.error(`Failed to send draft ${draft.id}:`, error);
      results.failed++;
      results.errors.push({ draft_id: draft.id, error: error.message });
    }
  }

  await db.write();

  res.json({
    success: true,
    ...results,
    message: `Sent ${results.sent} draft(s), skipped ${results.skipped} objections, ${results.failed} failed`
  });
});

// Process Follow-Up Emails
async function processFollowUps() {
  console.log('🔄 Processing follow-up emails...');

  await db.read();

  for (const user of db.data.users) {
    try {
      const settings = db.data.email_settings.find(s => s.user_id === user.id);

      if (!settings || !settings.email) {
        continue; // Skip users without email configuration
      }

      // Get user's follow-up rules and mode
      const defaultRules = {
        INTERESTED: { delay_days: 1, max_attempts: 5, after_max: 'review' },
        NOT_NOW: { delay_days: 7, max_attempts: 3, after_max: 'GHOSTING' },
        OBJECTION: { delay_days: 3, max_attempts: 4, after_max: 'review' },
        GHOSTING: { delay_days: 5, max_attempts: 3, after_max: 'DEAD' },
        DEAD: { delay_days: 30, max_attempts: 1, after_max: 'closed_by_system' }
      };

      const followUpRules = user.per_intent_settings || defaultRules;
      const autoModeEnabled = user.auto_mode_enabled || false;

      // Find leads that need follow-up
      const userLeads = db.data.leads.filter(l => l.user_id === user.id);

      for (const lead of userLeads) {
        // Skip leads that haven't been contacted yet
        if (!lead.initial_email_sent && !lead.last_email_sent_date) {
          continue;
        }

        // Skip leads where a human has taken over — but not in auto mode (AI always continues)
        if (lead.ai_paused_by_human === true && !autoModeEnabled) {
          continue;
        }

        // Skip leads that are closed or customers
        if (lead.status === 'customer' || lead.status === 'closed_by_system') {
          continue;
        }

        // Skip leads manually paused from follow-up rules
        if (lead.follow_up_paused === true) {
          continue;
        }

        // Skip leads currently in an active (non-paused) sequence — sequence has priority
        // If sequence is paused (e.g. customer replied), let processFollowUps take over
        if (lead.enrolled_sequence_id && lead.sequence_completed === false && !lead.sequence_paused) {
          continue;
        }

        // Skip leads whose sequence just completed — use sequence_last_sent as the
        // actual last email time so we don't immediately fire another follow-up
        if (lead.enrolled_sequence_id && lead.sequence_completed === true && lead.sequence_last_sent) {
          const msSinceSequenceEnd = Date.now() - new Date(lead.sequence_last_sent).getTime();
          const intent = lead.ai_intent || 'GHOSTING';
          const rules = followUpRules[intent];
          if (rules) {
            const delayMs = rules.delay_unit === 'minutes'
              ? rules.delay_days * 60 * 1000
              : rules.delay_days * 24 * 60 * 60 * 1000;
            if (msSinceSequenceEnd < delayMs) {
              continue; // Not enough time has passed since sequence ended
            }
          }
        }

        // Get follow-up rules for this lead's intent/status
        const intent = lead.ai_intent || 'GHOSTING'; // Default to GHOSTING if no intent
        const rules = followUpRules[intent];

        if (!rules) {
          continue;
        }

        // Use follow_up_count (not email_count) so max_attempts = N means exactly N follow-ups.
        // email_count includes the initial email and would consume one slot silently.
        const followUpCount = lead.follow_up_count || 0;
        const lastEmailDate = new Date(lead.last_email_sent_date || lead.initial_email_sent_date);
        const msSinceLastEmail = Date.now() - lastEmailDate.getTime();
        const delayMs = rules.delay_unit === 'minutes'
          ? rules.delay_days * 60 * 1000
          : rules.delay_days * 24 * 60 * 60 * 1000;

        // Check if it's time to send a follow-up
        if (msSinceLastEmail >= delayMs) {
          if (followUpCount < rules.max_attempts) {
            // Re-check pause status from live db.data (may have changed since processFollowUps started)
            // Fixes concurrency bug where pause API update could be overwritten
            const liveLeadIdx = db.data.leads.findIndex(l => l.id === lead.id);
            if (liveLeadIdx !== -1 && db.data.leads[liveLeadIdx].follow_up_paused === true) {
              console.log(`⏸️  Skipping ${lead.email} — follow-ups were paused`);
              continue;
            }

            // Generate follow-up email
            console.log(`📧 Generating follow-up for ${lead.first_name} ${lead.last_name} (attempt ${followUpCount + 1}/${rules.max_attempts})`);

            try {
              const result = await generateFollowUpEmail(lead, followUpCount + 1, intent, user.id);
              const followUpBody = result?.body;
              const abVariant = result?.variant || 'A';

              if (followUpBody) {
                // Increment AI generation counter for this user
                const uIdxFollowUp = db.data.users.findIndex(u => u.id === user.id);
                if (uIdxFollowUp !== -1) {
                  db.data.users[uIdxFollowUp].ai_generations_this_month =
                    (db.data.users[uIdxFollowUp].ai_generations_this_month || 0) + 1;
                }

                // Track A/B send count for this user+intent
                if (!db.data.ab_results) db.data.ab_results = [];
                let abRecord = db.data.ab_results.find(r => r.user_id === user.id && r.intent === intent);
                if (!abRecord) {
                  abRecord = { id: db.data.ab_results.length + 1, user_id: user.id, intent, variant_a_sends: 0, variant_a_replies: 0, variant_b_sends: 0, variant_b_replies: 0, winner: null, created_at: new Date().toISOString() };
                  db.data.ab_results.push(abRecord);
                }
                if (abVariant === 'A') abRecord.variant_a_sends++;
                else abRecord.variant_b_sends++;

                // Auto-select winner after 10 sends per variant
                if (!abRecord.winner && abRecord.variant_a_sends >= 10 && abRecord.variant_b_sends >= 10) {
                  const rateA = abRecord.variant_a_replies / abRecord.variant_a_sends;
                  const rateB = abRecord.variant_b_replies / abRecord.variant_b_sends;
                  abRecord.winner = rateA >= rateB ? 'A' : 'B';
                  console.log(`🏆 A/B winner for ${intent}: Variant ${abRecord.winner} (A: ${(rateA * 100).toFixed(1)}% vs B: ${(rateB * 100).toFixed(1)}%)`);
                }

                // Check if auto mode is enabled for this intent
                const intentAllowedInAuto = intent === 'INTERESTED' ||
                                            intent === 'NOT_NOW' ||
                                            intent === 'GHOSTING' ||
                                            (intent === 'OBJECTION' && user.auto_mode_include_objections);

                if (autoModeEnabled && intentAllowedInAuto) {
                  // Send immediately (fully automated)
                  const senderName = `${user.company_name || 'Your Team'}`;
                  await sendEmail(settings, lead.email, `Following up - ${lead.company || 'our conversation'}`, followUpBody, senderName, {
                    lead_id: lead.id
                  });

                  // Re-find lead in db.data — generateFollowUpEmail calls db.read() internally
                  // which replaces db.data, detaching the old `lead` reference. Must use findIndex.
                  const liveLeadIdx = db.data.leads.findIndex(l => l.id === lead.id);
                  if (liveLeadIdx !== -1) {
                    db.data.leads[liveLeadIdx].follow_up_count = followUpCount + 1;
                    db.data.leads[liveLeadIdx].email_count = (db.data.leads[liveLeadIdx].email_count || 0) + 1;
                    db.data.leads[liveLeadIdx].last_email_sent_date = new Date().toISOString();
                  }

                  // Store in email history with ab_variant for reply tracking
                  db.data.email_history.push({
                    id: db.data.email_history.length + 1,
                    lead_id: lead.id,
                    user_id: user.id,
                    email_type: 'follow_up',
                    subject: `Following up - ${lead.company || 'our conversation'}`,
                    body: followUpBody,
                    ab_variant: abVariant,
                    sent_at: new Date().toISOString(),
                    status: 'sent'
                  });

                  console.log(`✅ Follow-up sent to ${lead.email} (AUTO mode, Variant ${abVariant})`);
                } else {
                  // Create draft for approval (MANUAL mode or OBJECTION requires review)
                  db.data.ai_drafts.push({
                    id: db.data.ai_drafts.length + 1,
                    lead_id: lead.id,
                    user_id: user.id,
                    draft_body: followUpBody,
                    ai_intent: intent,
                    ab_variant: abVariant,
                    status: 'pending',
                    created_at: new Date().toISOString()
                  });

                  console.log(`📝 Follow-up draft created for ${lead.email} (MANUAL mode, Variant ${abVariant})`);
                }
              }
            } catch (error) {
              console.error(`Failed to generate follow-up for lead ${lead.id}:`, error);
            }
          } else {
            // Max attempts reached - apply after_max action
            console.log(`⚠️ Max attempts reached for ${lead.first_name} ${lead.last_name} - applying after_max: ${rules.after_max}`);

            // Use findIndex to update the live db.data object (lead ref may be detached)
            const afterMaxIdx = db.data.leads.findIndex(l => l.id === lead.id);
            if (afterMaxIdx !== -1) {
              if (rules.after_max === 'review') {
                db.data.leads[afterMaxIdx].status = 'review';
              } else if (rules.after_max === 'closed_by_system') {
                db.data.leads[afterMaxIdx].status = 'closed_by_system';
              } else {
                // Change intent (e.g., NOT_NOW -> GHOSTING)
                db.data.leads[afterMaxIdx].ai_intent = rules.after_max;
                db.data.leads[afterMaxIdx].status = rules.after_max.toLowerCase();
              }
              // Reset follow_up_count so the next intent's max_attempts starts from zero
              db.data.leads[afterMaxIdx].follow_up_count = 0;
              db.data.leads[afterMaxIdx].updated_at = new Date().toISOString();
            }
          }
        }
      }

      await db.write();
    } catch (error) {
      console.error(`Error processing follow-ups for user ${user.id}:`, error);
    }
  }
}

// Generate Follow-Up Email with AI (A/B Testing + AI Learning)
async function generateFollowUpEmail(lead, attemptNumber, intent, userId) {
  try {
    await db.read();
    const productProfile = db.data.product_profiles.find(p => p.user_id === userId);
    const sellerProfile = db.data.seller_profiles.find(p => p.user_id === userId);
    const userRecord = db.data.users.find(u => u.id === userId);

    const sellerContext = getSellerContext(sellerProfile);
    const businessTypeContext = getBusinessTypeContext(userRecord?.business_type || 'other');
    const businessKnowledgeContext = getBusinessKnowledgeContext(userRecord?.business_knowledge || '', userRecord?.live_updates || '');
    const customInstructionsContext = getCustomInstructionsContext(userRecord?.ai_custom_instructions || '');

    let productContext = '';
    if (productProfile) {
      productContext = `
YOUR PRODUCT/SERVICE INFO:
- Product: ${productProfile.product_name || ''}
- Description: ${productProfile.product_description || ''}
- Key Benefits: ${productProfile.key_benefits || ''}
- Unique Value: ${productProfile.unique_selling_points || ''}
${productProfile.special_offers ? `- Special Offer: ${productProfile.special_offers}` : ''}
- Target Audience: ${productProfile.target_audience || ''}
- CTA: ${productProfile.call_to_action || 'Schedule a call'}`;
    }

    // ── A/B TESTING: Determine which style variant to use ──────────────────
    // Variant A = Direct & Short (punchy, question-based, max 60 words)
    // Variant B = Warm & Detailed (friendly, value-focused, max 100 words)
    let abVariant = lead.id % 2 === 0 ? 'A' : 'B';

    // Check if a winner has already been decided for this user+intent
    const abResult = (db.data.ab_results || []).find(r => r.user_id === userId && r.intent === intent);
    if (abResult && abResult.winner) {
      abVariant = abResult.winner;
    }

    const variantInstruction = abVariant === 'A'
      ? `STYLE: Direct & Short. Be punchy and concise. Lead with a direct question. Maximum 60 words.`
      : `STYLE: Warm & Detailed. Be friendly and conversational. Lead with value. Maximum 100 words.`;

    // ── AI LEARNING: Inject winning email examples ─────────────────────────
    // Pull up to 3 emails from this user that previously got positive replies
    const winningEmails = (db.data.winning_emails || [])
      .filter(w => w.user_id === userId)
      .slice(-3); // most recent 3

    let winningContext = '';
    if (winningEmails.length > 0) {
      winningContext = `\n\nEMAILS THAT GOT POSITIVE REPLIES FROM YOUR CUSTOMERS (use as style inspiration):
${winningEmails.map((w, i) => `Example ${i + 1}: "${w.body.substring(0, 200)}${w.body.length > 200 ? '…' : ''}"`).join('\n')}`;
    }

    // Check if there is any previous conversation with this lead
    const sentEmails = (db.data.email_interactions || [])
      .filter(i => i.lead_id === lead.id && i.direction === 'sent')
      .sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));
    const lastSentEmail = sentEmails[0]?.body || '';
    const lastCustomerReply = lead.last_reply || '';
    const hasConversation = !!(lastSentEmail || lastCustomerReply);

    const sharedContext = `Lead: ${lead.first_name} ${lead.last_name}${lead.company ? ' at ' + lead.company : ''}
Follow-up attempt: #${attemptNumber}
${productContext}${sellerContext}${businessTypeContext ? '\n\n' + businessTypeContext : ''}${businessKnowledgeContext ? '\n\n' + businessKnowledgeContext : ''}${customInstructionsContext ? '\n\n' + customInstructionsContext : ''}${winningContext}`;

    const outputRule = `\nIMPORTANT: Output ONLY the email body. Do NOT include a subject line. Start directly with the greeting (e.g. "Hi ${lead.first_name},"). Do NOT use placeholder text like [Your Name] — use the sender info provided above.\n\n${variantInstruction}\n\nEmail:`;

    let promptContent;

    if (hasConversation) {
      // ── PATH A: Has previous conversation ──────────────────────────────────
      let history = '';
      if (lastSentEmail) {
        history += `\nYOUR LAST EMAIL TO THEM:\n"${lastSentEmail.substring(0, 400)}${lastSentEmail.length > 400 ? '…' : ''}"`;
      }
      if (lastCustomerReply) {
        history += `\nTHEIR LAST REPLY:\n"${lastCustomerReply.substring(0, 300)}${lastCustomerReply.length > 300 ? '…' : ''}"`;
      }

      const intentInstructions = {
        INTERESTED: `${lead.first_name} showed interest but hasn't replied since your last email. Write a short warm follow-up that picks up from where the conversation left off and gently nudges them toward the next step.`,
        NOT_NOW: `${lead.first_name} said "not now" in your previous exchange. Write a brief check-in that acknowledges your last conversation and offers a fresh reason or angle to reconsider.`,
        OBJECTION: `${lead.first_name} raised a concern in your last exchange. Write a brief follow-up that directly addresses that concern using the product knowledge above.`,
        GHOSTING: `${lead.first_name} hasn't responded since your last email. Write a short re-engagement that references what was discussed and tries a slightly different angle. No pressure tone.`,
        DEAD: `Write a gracious final email to ${lead.first_name} referencing your previous conversation. Leave the door open. No hard sell.`
      };

      promptContent = `${intentInstructions[intent] || intentInstructions.GHOSTING}

${sharedContext}

PREVIOUS CONVERSATION (read carefully — your follow-up must be relevant to this):${history}
${outputRule}`;

    } else {
      // ── PATH B: No previous conversation — fresh outreach ─────────────────
      promptContent = `Write a professional, persuasive outreach email to ${lead.first_name} ${lead.last_name}${lead.company ? ' at ' + lead.company : ''} as a follow-up. There is no previous conversation — treat this as a first meaningful contact.

Base the email entirely on the business knowledge and product information below. Be specific, not generic. Reference real details from the knowledge base to make it feel personal and relevant.

${sharedContext}
${outputRule}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: promptContent }]
      })
    });

    if (response.ok) {
      const data = await response.json();
      return { body: data.content[0].text.trim(), variant: abVariant };
    }
  } catch (error) {
    console.error('AI follow-up generation error:', error);
  }

  // Fallback
  return { body: `Hi ${lead.first_name},\n\nJust wanted to follow up on my previous message. Is this still on your radar?\n\nBest regards`, variant: 'A' };
}

// ⚡ EMAIL POLLING DISABLED - Using push webhooks instead for instant delivery
// To receive emails instantly, configure your email provider to send webhooks to: /api/webhooks/inbound-email
// Supported providers:
// - Gmail: Set up Gmail Push Notifications (https://developers.google.com/gmail/api/guides/push)
// - SendGrid: Configure Inbound Parse Webhook (https://sendgrid.com/docs/for-developers/parsing-email/setting-up-the-inbound-parse-webhook/)
// - Postmark: Set up Inbound Hook (https://postmarkapp.com/developer/webhooks/inbound)
// - Microsoft 365: Use Change Notifications (https://learn.microsoft.com/en-us/graph/webhooks)
//
// Optional: Keep this cron for backup polling if webhook fails
// cron.schedule('*/5 * * * *', async () => { ... });

// Send Email using Template
app.post('/api/send-email', authenticate, async (req, res) => {
  const { template_id, lead_ids, subject, html } = req.body;

  if (!lead_ids || lead_ids.length === 0) {
    return res.status(400).json({ error: 'No recipients selected' });
  }

  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: 'Subject line is required' });
  }

  if (!html) {
    return res.status(400).json({ error: 'Email template HTML is required' });
  }

  await db.read();

  // Get user's email settings
  const settings = db.data.email_settings.find(s => s.user_id === req.userId);
  if (!settings || settings.provider !== 'gmail') {
    return res.status(400).json({
      error: 'Gmail not connected. Please connect Gmail in Settings first.'
    });
  }

  // Get leads
  const leads = db.data.leads.filter(lead =>
    lead.user_id === req.userId && lead_ids.includes(lead.id)
  );

  if (leads.length === 0) {
    return res.status(400).json({ error: 'No valid leads found' });
  }

  // Function to replace variables in text
  const replaceVariables = (text, lead) => {
    return text
      .replace(/\{\{first_name\}\}/g, lead.first_name || '')
      .replace(/\{\{last_name\}\}/g, lead.last_name || '')
      .replace(/\{\{company\}\}/g, lead.company || '')
      .replace(/\{\{email\}\}/g, lead.email || '')
      .replace(/\{\{phone\}\}/g, lead.phone || '');
  };

  // Send emails to each lead
  const results = {
    success: [],
    failed: []
  };

  for (const lead of leads) {
    try {
      // Replace variables in subject and HTML
      const personalizedSubject = replaceVariables(subject, lead);
      const personalizedHtml = replaceVariables(html, lead);

      // Send email
      await sendEmail(
        settings,
        lead.email,
        personalizedSubject,
        '', // text body (not used, HTML is provided)
        null, // sender name (will use default from settings)
        { html: personalizedHtml, lead_id: lead.id }
      );

      results.success.push({
        lead_id: lead.id,
        email: lead.email,
        name: `${lead.first_name} ${lead.last_name}`
      });

      console.log(`✅ Email sent to ${lead.email}`);
    } catch (error) {
      results.failed.push({
        lead_id: lead.id,
        email: lead.email,
        name: `${lead.first_name} ${lead.last_name}`,
        error: error.message
      });

      console.error(`❌ Failed to send email to ${lead.email}:`, error.message);
    }
  }

  // Return results
  const successCount = results.success.length;
  const failedCount = results.failed.length;

  if (successCount > 0 && failedCount === 0) {
    res.json({
      message: `Successfully sent ${successCount} email${successCount > 1 ? 's' : ''}!`,
      results
    });
  } else if (successCount > 0 && failedCount > 0) {
    res.json({
      message: `Sent ${successCount} email${successCount > 1 ? 's' : ''}, ${failedCount} failed`,
      results
    });
  } else {
    res.status(500).json({
      error: `Failed to send all emails`,
      results
    });
  }
});

// ============================================================
// SEQUENCE STEP SCHEDULER
// Sends sequence steps based on each step's delay_days/delay_unit
// ============================================================
let _sequenceProcessing = false; // lock to prevent overlapping runs

async function processSequenceSteps() {
  if (_sequenceProcessing) {
    console.log('⏭️ Sequence processing already running, skipping this cycle');
    return;
  }
  _sequenceProcessing = true;
  const startTime = Date.now();
  try {
  console.log('📅 Processing sequence steps...');
  await db.read();

  const now = Date.now();

  // Get all leads currently enrolled in a sequence and not yet completed
  const enrolledLeads = (db.data.leads || []).filter(l =>
    l.enrolled_sequence_id &&
    l.sequence_completed === false &&
    !l.sequence_paused &&
    l.sequence_last_sent
  );

  for (const lead of enrolledLeads) {
    try {
      const seqId = lead.enrolled_sequence_id;
      const sequence = (db.data.sequences || []).find(s => s.id === seqId);
      if (!sequence || !sequence.is_active) continue;

      const steps = (db.data.sequence_steps || [])
        .filter(s => s.sequence_id === seqId)
        .sort((a, b) => a.step_number - b.step_number);

      const nextStepIndex = lead.sequence_current_step; // 0-based array index of the next step to send
      if (nextStepIndex >= steps.length) {
        // All steps sent — mark complete so AI auto-send can take over
        const idx = db.data.leads.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          db.data.leads[idx].sequence_completed = true;
          // Check if ALL leads in this sequence are now completed → auto-deactivate
          const allEnrolledLeads = db.data.leads.filter(l => l.enrolled_sequence_id === seqId);
          const allCompleted = allEnrolledLeads.length > 0 && allEnrolledLeads.every(l => l.sequence_completed === true);
          if (allCompleted) {
            const seqIdx = db.data.sequences.findIndex(s => s.id === seqId);
            if (seqIdx !== -1 && db.data.sequences[seqIdx].is_active) {
              db.data.sequences[seqIdx].is_active = false;
              console.log(`🔒 All leads completed sequence "${db.data.sequences[seqIdx].name}" — auto-deactivated`);
            }
          }
        }
        console.log(`✅ Sequence complete for lead ${lead.email} — handing off to AI auto-send`);
        continue;
      }

      const nextStep = steps[nextStepIndex];
      const msSinceLastSent = now - new Date(lead.sequence_last_sent).getTime();
      const unit = nextStep.delay_unit || 'days';
      const elapsed = unit === 'minutes'
        ? msSinceLastSent / (1000 * 60)          // convert to minutes
        : msSinceLastSent / (1000 * 60 * 60 * 24); // convert to days

      if (elapsed < nextStep.delay_days) continue; // not time yet

      // Time to send the next step
      const user = db.data.users.find(u => u.id === lead.user_id);
      const settings = db.data.email_settings ? db.data.email_settings.find(s => s.user_id === lead.user_id) : null;
      if (!settings || settings.provider !== 'gmail') continue;

      const replaceVars = (text) => (text || '')
        .replace(/\{\{first_name\}\}/g, lead.first_name || '')
        .replace(/\{\{last_name\}\}/g, lead.last_name || '')
        .replace(/\{\{company\}\}/g, lead.company || '')
        .replace(/\{\{email\}\}/g, lead.email || '')
        .replace(/\{\{phone\}\}/g, lead.phone || '');

      const subject = replaceVars(nextStep.subject || sequence.name);
      const html = replaceVars(nextStep.email_template);

      let emailResult = null;
      try {
        emailResult = await sendEmail(settings, lead.email, subject, html, user ? user.company_name : null, {
          attachments: nextStep.attachments || [],
          lead_id: lead.id
        });
        console.log(`📤 Sequence step ${nextStepIndex + 1} sent to ${lead.email}`);
      } catch (sendErr) {
        console.error(`❌ Failed to send step ${nextStepIndex + 1} to ${lead.email}:`, sendErr.message);
        continue;
      }

      // Record interaction
      if (!db.data.email_interactions) db.data.email_interactions = [];
      db.data.email_interactions.push({
        id: db.data.email_interactions.length + 1,
        lead_id: lead.id,
        sequence_id: seqId,
        step_number: nextStepIndex + 1,
        direction: 'sent',
        subject,
        body: html,
        message_id: emailResult?.threading_message_id || null,
        sent_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      });

      // Advance the lead to the next step
      const idx = db.data.leads.findIndex(l => l.id === lead.id);
      if (idx !== -1) {
        db.data.leads[idx].sequence_current_step = nextStepIndex + 1;
        db.data.leads[idx].sequence_last_sent = new Date().toISOString();
        // Also update last_email_sent_date so processFollowUps uses the correct time
        db.data.leads[idx].last_email_sent_date = new Date().toISOString();
        // Check if this was the last step
        if (nextStepIndex + 1 >= steps.length) {
          db.data.leads[idx].sequence_completed = true;
          console.log(`✅ Last step sent to ${lead.email} — sequence complete, AI auto-send will take over`);

          // Check if ALL leads in this sequence are now completed → auto-deactivate sequence
          const seqId = lead.enrolled_sequence_id;
          const allEnrolledLeads = db.data.leads.filter(l => l.enrolled_sequence_id === seqId);
          const allCompleted = allEnrolledLeads.length > 0 && allEnrolledLeads.every(l => l.sequence_completed === true);
          if (allCompleted) {
            const seqIdx = db.data.sequences.findIndex(s => s.id === seqId);
            if (seqIdx !== -1 && db.data.sequences[seqIdx].is_active) {
              db.data.sequences[seqIdx].is_active = false;
              console.log(`🔒 All leads completed sequence "${db.data.sequences[seqIdx].name}" — auto-deactivated`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error processing sequence for lead ${lead.id}:`, err.message);
    }
  }

  await db.write();
  console.log(`📅 Sequence processing done in ${Date.now() - startTime}ms`);
  } catch (outerErr) {
    console.error('❌ Sequence processing error:', outerErr.message);
  } finally {
    _sequenceProcessing = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BILLING / STRIPE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/billing/verify-session — called after Stripe redirects back, updates plan without webhook
app.post('/api/billing/verify-session', authenticate, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'subscription.items.data.price']
    });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    await db.read();
    const uIdx = db.data.users.findIndex(u => u.id === req.userId);
    if (uIdx === -1) return res.status(404).json({ error: 'User not found' });

    // Determine plan from price ID
    const priceId = session.subscription?.items?.data[0]?.price?.id;
    let plan = 'starter';
    if (priceId === process.env.STRIPE_PRICE_GROWTH_MONTHLY || priceId === process.env.STRIPE_PRICE_GROWTH_ANNUAL) {
      plan = 'growth';
    }

    db.data.users[uIdx].plan = plan;
    db.data.users[uIdx].plan_status = 'active';
    db.data.users[uIdx].stripe_customer_id = session.customer;
    db.data.users[uIdx].stripe_subscription_id = session.subscription?.id || null;
    await db.write();

    console.log(`✅ Plan verified & updated for user ${req.userId}: ${plan}`);
    res.json({ success: true, plan });
  } catch (err) {
    console.error('Session verify error:', err.message);
    res.status(500).json({ error: 'Failed to verify session', detail: err.message });
  }
});

// GET /api/billing/status — current plan info for logged-in user
app.get('/api/billing/status', authenticate, async (req, res) => {
  await db.read();
  const user = db.data.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { plan, status, limits } = getUserPlan(user);
  const activeLeads = db.data.leads.filter(l =>
    l.user_id === req.userId && l.enrolled_sequence_id && !l.sequence_completed && l.status !== 'dead'
  ).length;

  res.json({
    plan,
    plan_name: limits.name,
    plan_status: status,
    trial_ends_at: user.trial_ends_at || null,
    active_leads_count: activeLeads,
    active_leads_limit: limits.active_leads_limit,
    ai_generations_this_month: user.ai_generations_this_month || 0,
    ai_generations_limit: limits.ai_generations_limit,
    sequences_limit: limits.sequences_limit
  });
});

// POST /api/billing/create-checkout — create a Stripe Checkout session
app.post('/api/billing/create-checkout', authenticate, async (req, res) => {
  const { price_id } = req.body;
  if (!price_id) return res.status(400).json({ error: 'price_id is required' });

  // Guard: detect unconfigured Stripe keys
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  if (!stripeKey || stripeKey.includes('REPLACE') || stripeKey === 'sk_test_placeholder') {
    return res.status(400).json({
      error: 'stripe_not_configured',
      message: 'Stripe is not configured yet. Add your STRIPE_SECRET_KEY to backend/.env'
    });
  }
  if (!price_id || price_id.includes('REPLACE')) {
    return res.status(400).json({
      error: 'price_not_configured',
      message: 'Stripe Price ID is not configured yet. Add your STRIPE_PRICE_* values to backend/.env'
    });
  }

  await db.read();
  const user = db.data.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    // Create or reuse Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: String(user.id) }
      });
      customerId = customer.id;
      const uIdx = db.data.users.findIndex(u => u.id === req.userId);
      db.data.users[uIdx].stripe_customer_id = customerId;
      await db.write();
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: price_id, quantity: 1 }],
      mode: 'subscription',
      success_url: `${appUrl}/billing?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${appUrl}/billing?canceled=true`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message, err.type, err.code);
    res.status(500).json({
      error: 'Failed to create checkout session',
      detail: err.message,
      type: err.type,
      code: err.code
    });
  }
});

// POST /api/billing/portal — create Stripe Customer Portal session (manage billing)
app.post('/api/billing/portal', authenticate, async (req, res) => {
  await db.read();
  const user = db.data.users.find(u => u.id === req.userId);
  if (!user || !user.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
  }

  try {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl}/billing`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// POST /api/webhooks/stripe — Stripe sends events here
// IMPORTANT: must use raw body (express.raw), not express.json
app.post('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Stripe webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    await db.read();

    const getUser = (customerId) => db.data.users.find(u => u.stripe_customer_id === customerId);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription') {
          const user = getUser(session.customer);
          if (user) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const priceId = subscription.items.data[0]?.price?.id;
            // Map price ID to plan name
            let plan = 'starter';
            if (priceId === process.env.STRIPE_PRICE_GROWTH_MONTHLY || priceId === process.env.STRIPE_PRICE_GROWTH_ANNUAL) {
              plan = 'growth';
            }
            const uIdx = db.data.users.findIndex(u => u.id === user.id);
            db.data.users[uIdx].plan = plan;
            db.data.users[uIdx].plan_status = 'active';
            db.data.users[uIdx].stripe_subscription_id = session.subscription;
            console.log(`✅ User ${user.email} subscribed to ${plan} plan`);
          }
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const user = getUser(invoice.customer);
        if (user && user.plan_status !== 'active') {
          const uIdx = db.data.users.findIndex(u => u.id === user.id);
          db.data.users[uIdx].plan_status = 'active';
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = getUser(invoice.customer);
        if (user) {
          const uIdx = db.data.users.findIndex(u => u.id === user.id);
          db.data.users[uIdx].plan_status = 'past_due';
          console.log(`⚠️  Payment failed for user ${user.email}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = getUser(sub.customer);
        if (user) {
          const uIdx = db.data.users.findIndex(u => u.id === user.id);
          db.data.users[uIdx].plan = 'trial';
          db.data.users[uIdx].plan_status = 'expired';
          db.data.users[uIdx].stripe_subscription_id = null;
          console.log(`❌ Subscription cancelled for user ${user.email}`);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = getUser(sub.customer);
        if (user) {
          const priceId = sub.items.data[0]?.price?.id;
          let plan = 'starter';
          if (priceId === process.env.STRIPE_PRICE_GROWTH_MONTHLY || priceId === process.env.STRIPE_PRICE_GROWTH_ANNUAL) {
            plan = 'growth';
          }
          const uIdx = db.data.users.findIndex(u => u.id === user.id);
          db.data.users[uIdx].plan = plan;
          db.data.users[uIdx].plan_status = sub.status === 'active' ? 'active' : sub.status;
          console.log(`🔄 Subscription updated for ${user.email}: ${plan} / ${sub.status}`);
        }
        break;
      }
    }

    await db.write();
    res.json({ received: true });
  }
);

// ─── Appointments ──────────────────────────────────────────────────────────────

// POST /api/appointments — book appointment for an interested lead
app.post('/api/appointments', authenticate, async (req, res) => {
  const { lead_id, date, time, timezone, duration_minutes, meeting_link, notes } = req.body;
  if (!lead_id || !date || !time) {
    return res.status(400).json({ error: 'lead_id, date, and time are required' });
  }

  await db.read();
  const lead = db.data.leads.find(l => String(l.id) === String(lead_id) && l.user_id === req.userId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const appointment = {
    id: Date.now(),
    user_id: req.userId,
    lead_id: lead.id, // use the actual stored id to keep type consistent
    date,
    time,
    timezone: timezone || 'UTC',
    duration_minutes: duration_minutes || 30,
    meeting_link: meeting_link || '',
    notes: notes || '',
    status: 'scheduled',
    outcome: null,
    reminder_24h_sent: false,
    reminder_1h_sent: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.data.appointments.push(appointment);

  const leadIdx = db.data.leads.findIndex(l => l.id === lead_id);
  if (leadIdx !== -1) {
    db.data.leads[leadIdx].status = 'appointment_scheduled';
    db.data.leads[leadIdx].updated_at = new Date().toISOString();
  }

  await db.write();

  // Send confirmation email to lead
  const emailSettings = db.data.email_settings.find(s => s.user_id === req.userId);
  if (emailSettings) {
    try {
      const dateObj = new Date(`${date}T${time}`);
      const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const confirmBody = `Hi ${lead.first_name || lead.email},\n\nYour appointment has been confirmed!\n\n📅 Date: ${formattedDate}\n⏰ Time: ${time} (${timezone || 'UTC'})\n⏱ Duration: ${duration_minutes || 30} minutes\n${meeting_link ? `🔗 Meeting Link: ${meeting_link}\n` : ''}${notes ? `📝 Notes: ${notes}\n` : ''}\nLooking forward to speaking with you!`;
      await sendEmail(emailSettings, lead.email, 'Your Appointment is Confirmed', confirmBody);
      console.log(`📅 Confirmation email sent to ${lead.email}`);
    } catch (e) {
      console.error('Appointment confirmation email failed:', e.message);
    }
  }

  res.status(201).json({ appointment });
});

// GET /api/appointments — list all appointments for user
app.get('/api/appointments', authenticate, async (req, res) => {
  await db.read();
  const appointments = (db.data.appointments || [])
    .filter(a => a.user_id === req.userId)
    .map(apt => {
      const lead = db.data.leads.find(l => l.id === apt.lead_id);
      return {
        ...apt,
        lead: lead
          ? { id: lead.id, first_name: lead.first_name, last_name: lead.last_name, email: lead.email, company: lead.company }
          : null
      };
    })
    .sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));

  res.json({ appointments });
});

// PATCH /api/appointments/:id — reschedule or restore appointment
app.patch('/api/appointments/:id', authenticate, async (req, res) => {
  await db.read();
  const aptId = parseInt(req.params.id);
  const idx = db.data.appointments.findIndex(a => a.id === aptId && a.user_id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Appointment not found' });

  const apt = db.data.appointments[idx];

  // Allow restoring a cancelled appointment back to scheduled
  if (req.body.status === 'scheduled' && apt.status === 'cancelled') {
    apt.status = 'scheduled';
    apt.updated_at = new Date().toISOString();
    await db.write();
    return res.json({ appointment: db.data.appointments[idx] });
  }

  const { date, time, timezone, duration_minutes, appointment_type, meeting_link, notes } = req.body;
  const wasRescheduled = (date && date !== apt.date) || (time && time !== apt.time);

  if (date) apt.date = date;
  if (time) apt.time = time;
  if (timezone) apt.timezone = timezone;
  if (duration_minutes) apt.duration_minutes = duration_minutes;
  if (appointment_type) apt.appointment_type = appointment_type;
  if (meeting_link !== undefined) apt.meeting_link = meeting_link;
  if (notes !== undefined) apt.notes = notes;
  if (wasRescheduled) {
    apt.reminder_24h_sent = false;
    apt.reminder_1h_sent = false;
  }
  apt.updated_at = new Date().toISOString();

  await db.write();

  if (wasRescheduled) {
    const lead = db.data.leads.find(l => l.id === apt.lead_id);
    const emailSettings = db.data.email_settings.find(s => s.user_id === req.userId);
    if (lead && emailSettings) {
      try {
        const dateObj = new Date(`${apt.date}T${apt.time}`);
        const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const rescheduleBody = `Hi ${lead.first_name || lead.email},\n\nYour appointment has been rescheduled. Here are the updated details:\n\n📅 Date: ${formattedDate}\n⏰ Time: ${apt.time} (${apt.timezone})\n⏱ Duration: ${apt.duration_minutes} minutes\n${apt.meeting_link ? `🔗 Meeting Link: ${apt.meeting_link}\n` : ''}\nSee you then!`;
        await sendEmail(emailSettings, lead.email, 'Your Appointment has been Rescheduled', rescheduleBody);
      } catch (e) {
        console.error('Reschedule email failed:', e.message);
      }
    }
  }

  res.json({ appointment: db.data.appointments[idx] });
});

// DELETE /api/appointments/:id — cancel appointment
app.delete('/api/appointments/:id', authenticate, async (req, res) => {
  await db.read();
  const aptId = parseInt(req.params.id);
  const idx = db.data.appointments.findIndex(a => a.id === aptId && a.user_id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'Appointment not found' });

  db.data.appointments[idx].status = 'cancelled';
  db.data.appointments[idx].updated_at = new Date().toISOString();
  await db.write();

  res.json({ message: 'Appointment cancelled' });
});

// PATCH /api/appointments/:id/outcome — mark what happened after the appointment
app.patch('/api/appointments/:id/outcome', authenticate, async (req, res) => {
  const { outcome } = req.body;
  const validOutcomes = ['won', 'needs_more_time', 'no_show', 'not_a_fit'];
  if (!validOutcomes.includes(outcome)) {
    return res.status(400).json({ error: 'Invalid outcome. Use: won, needs_more_time, no_show, not_a_fit' });
  }

  await db.read();
  const aptId = parseInt(req.params.id);
  const aptIdx = db.data.appointments.findIndex(a => a.id === aptId && a.user_id === req.userId);
  if (aptIdx === -1) return res.status(404).json({ error: 'Appointment not found' });

  const apt = db.data.appointments[aptIdx];
  apt.outcome = outcome;
  apt.status = 'completed';
  apt.completed_at = new Date().toISOString();
  apt.updated_at = new Date().toISOString();

  const lead = db.data.leads.find(l => l.id === apt.lead_id);
  const emailSettings = db.data.email_settings.find(s => s.user_id === req.userId);
  const leadIdx = db.data.leads.findIndex(l => l.id === apt.lead_id);

  if (outcome === 'won') {
    if (leadIdx !== -1) {
      db.data.leads[leadIdx].status = 'converted';
      db.data.leads[leadIdx].sequence_paused = true;
      db.data.leads[leadIdx].updated_at = new Date().toISOString();
    }
    if (lead && emailSettings) {
      try {
        const wonBody = `Hi ${lead.first_name || lead.email},\n\nGreat news — we're moving forward! 🎉\n\nThank you for your time on our call. I'm excited to have you on board.\n\nI'll be in touch shortly with the next steps. If you have any questions in the meantime, feel free to reply to this email.\n\nLooking forward to working with you!`;
        await sendEmail(emailSettings, lead.email, 'Welcome aboard! Here are your next steps', wonBody);
        console.log(`🎉 Won email sent to ${lead.email}`);
      } catch (e) { console.error('Won email failed:', e.message); }
    }
  } else if (outcome === 'needs_more_time') {
    if (leadIdx !== -1) {
      db.data.leads[leadIdx].status = 'nurture';
      db.data.leads[leadIdx].next_followup_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.data.leads[leadIdx].sequence_paused = false;
      db.data.leads[leadIdx].updated_at = new Date().toISOString();
    }
    if (lead && emailSettings) {
      try {
        const followUpBody = `Hi ${lead.first_name || lead.email},\n\nGreat speaking with you! I understand the timing isn't perfect right now.\n\nI'll check back in with you in about a week — but in the meantime, feel free to reach out whenever you're ready. I'm happy to help!\n\nTalk soon.`;
        await sendEmail(emailSettings, lead.email, 'Great speaking with you!', followUpBody);
        console.log(`⏰ Nurture email sent to ${lead.email}`);
      } catch (e) { console.error('Nurture email failed:', e.message); }
    }
  } else if (outcome === 'no_show') {
    if (leadIdx !== -1) {
      db.data.leads[leadIdx].status = 'no_show';
      db.data.leads[leadIdx].updated_at = new Date().toISOString();
    }
    if (lead && emailSettings) {
      try {
        const noShowBody = `Hi ${lead.first_name || lead.email},\n\nI noticed we missed each other for our scheduled call — no worries at all!\n\nI'd love to find another time that works better for you. Would you like to reschedule? Just reply with a few times that work and I'll get it sorted.\n\nLooking forward to connecting!`;
        await sendEmail(emailSettings, lead.email, 'Missed our call — want to reschedule?', noShowBody);
        console.log(`📞 No-show reschedule email sent to ${lead.email}`);
      } catch (e) { console.error('No-show email failed:', e.message); }
    }
  } else if (outcome === 'not_a_fit') {
    if (leadIdx !== -1) {
      db.data.leads[leadIdx].status = 'dead';
      db.data.leads[leadIdx].sequence_paused = true;
      db.data.leads[leadIdx].updated_at = new Date().toISOString();
    }
  }

  await db.write();
  res.json({
    appointment: db.data.appointments[aptIdx],
    lead: leadIdx !== -1 ? db.data.leads[leadIdx] : null
  });
});

// GET /api/appointments/notifications — return unnotified AI-detected appointments, then mark them notified
app.get('/api/appointments/notifications', authenticate, async (req, res) => {
  await db.read();
  const unnotified = (db.data.appointments || [])
    .filter(a => a.user_id === req.userId && a.source === 'ai_detected' && a.notified === false);

  // Enrich with lead data
  const enriched = unnotified.map(apt => {
    const lead = db.data.leads.find(l => l.id === apt.lead_id);
    return {
      ...apt,
      lead: lead
        ? { id: lead.id, first_name: lead.first_name, last_name: lead.last_name, email: lead.email, company: lead.company }
        : null
    };
  });

  // Mark all as notified
  if (unnotified.length > 0) {
    unnotified.forEach(apt => {
      const idx = db.data.appointments.findIndex(a => a.id === apt.id);
      if (idx !== -1) db.data.appointments[idx].notified = true;
    });
    await db.write();
  }

  res.json({ notifications: enriched });
});

// ─── Appointment Reminders ──────────────────────────────────────────────────────

async function checkAppointmentReminders() {
  try {
    await db.read();
    const now = Date.now();
    const scheduled = (db.data.appointments || []).filter(a => a.status === 'scheduled');
    let changed = false;

    for (const apt of scheduled) {
      const aptTime = new Date(`${apt.date}T${apt.time}`).getTime();
      if (isNaN(aptTime)) continue;

      const timeUntilMs = aptTime - now;
      const lead = db.data.leads.find(l => l.id === apt.lead_id);
      const emailSettings = db.data.email_settings.find(s => s.user_id === apt.user_id);

      if (!lead || !emailSettings) continue;

      const dateObj = new Date(aptTime);
      const formattedDate = dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      // 24h reminder window: between 23h55m and 24h05m before appointment
      const msIn24h = 24 * 60 * 60 * 1000;
      if (!apt.reminder_24h_sent && timeUntilMs > 0 && timeUntilMs <= msIn24h + 5 * 60 * 1000 && timeUntilMs > msIn24h - 5 * 60 * 1000) {
        try {
          const body = `Hi ${lead.first_name || lead.email},\n\nJust a reminder — we have a call scheduled tomorrow!\n\n📅 ${formattedDate}\n⏰ Time: ${apt.time} (${apt.timezone})\n⏱ Duration: ${apt.duration_minutes} minutes\n${apt.meeting_link ? `🔗 Join here: ${apt.meeting_link}\n` : ''}\nSee you soon!`;
          await sendEmail(emailSettings, lead.email, 'Reminder: Your call is tomorrow', body);
          apt.reminder_24h_sent = true;
          changed = true;
          console.log(`🔔 24h reminder sent to ${lead.email}`);
        } catch (e) { console.error('24h reminder failed:', e.message); }
      }

      // 1h reminder window: between 55m and 65m before appointment
      const msIn1h = 60 * 60 * 1000;
      if (!apt.reminder_1h_sent && timeUntilMs > 0 && timeUntilMs <= msIn1h + 5 * 60 * 1000 && timeUntilMs > msIn1h - 5 * 60 * 1000) {
        try {
          const body = `Hi ${lead.first_name || lead.email},\n\nYour call starts in 1 hour!\n\n📅 ${formattedDate}\n⏰ Time: ${apt.time} (${apt.timezone})\n${apt.meeting_link ? `🔗 Join here: ${apt.meeting_link}\n` : ''}\nTalk soon!`;
          await sendEmail(emailSettings, lead.email, 'Your call starts in 1 hour', body);
          apt.reminder_1h_sent = true;
          changed = true;
          console.log(`🔔 1h reminder sent to ${lead.email}`);
        } catch (e) { console.error('1h reminder failed:', e.message); }
      }
    }

    if (changed) await db.write();
  } catch (err) {
    console.error('Appointment reminder check error:', err);
  }
}

// ─── Proactive Gmail Token Refresh ──────────────────────────────────────────
// Prevents email send failures due to expired access tokens by refreshing
// proactively every 5 minutes (Gmail tokens last 1 hour)
async function refreshAllGmailTokens() {
  try {
    await db.read();

    const gmailSettings = (db.data.email_settings || []).filter(
      s => s.provider === 'gmail' && s.refresh_token
    );

    for (const settings of gmailSettings) {
      try {
        // Skip if already marked as needing reconnection (prevent hammering Google API)
        if (settings.token_invalid) {
          continue; // Skip — user must reconnect manually
        }

        // Refresh if token expires within 10 minutes OR is already expired
        const TEN_MIN = 10 * 60 * 1000;
        if (settings.token_expiry && settings.token_expiry > Date.now() + TEN_MIN) {
          continue; // Still fresh — skip
        }

        console.log(`🔄 [TokenRefresh] Refreshing token for user ${settings.user_id} (${settings.email})...`);

        oauth2Client.setCredentials({
          access_token: settings.access_token,
          refresh_token: settings.refresh_token,
          expiry_date: settings.token_expiry
        });

        const { credentials } = await oauth2Client.refreshAccessToken();

        const dbSettings = db.data.email_settings.find(s => s.user_id === settings.user_id);
        if (dbSettings) {
          dbSettings.access_token = credentials.access_token;
          dbSettings.token_expiry = credentials.expiry_date;
          dbSettings.updated_at = new Date().toISOString();
          await db.write();
          console.log(`✅ [TokenRefresh] Token refreshed for user ${settings.user_id} — expires ${new Date(credentials.expiry_date).toISOString()}`);
        }
      } catch (err) {
        // Detect permanently broken refresh_token (invalid_grant = token revoked/expired)
        if (err.message.includes('invalid_grant') || err.response?.data?.error === 'invalid_grant') {
          console.error(`❌ [TokenRefresh] PERMANENT FAILURE for user ${settings.user_id}: refresh_token is invalid. User must reconnect Gmail.`);

          // Mark this account as needing reconnection to stop repeated failed refresh attempts
          const dbSettings = db.data.email_settings.find(s => s.user_id === settings.user_id);
          if (dbSettings) {
            dbSettings.token_invalid = true;
            dbSettings.token_invalid_since = new Date().toISOString();
            await db.write();
            console.log(`✅ Marked user ${settings.user_id} email settings with token_invalid flag`);
          }
        } else {
          // Temporary error (network, rate limit, etc.) — try again next cycle
          console.error(`❌ [TokenRefresh] Temporary failure for user ${settings.user_id} (${settings.email}):`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('❌ [TokenRefresh] Job error:', err.message);
  }
}

// Check appointment reminders every minute
cron.schedule('* * * * *', async () => {
  await checkAppointmentReminders();
});

// Process follow-ups every minute (supports minute-level delay rules)
cron.schedule('* * * * *', async () => {
  await processFollowUps();
});

// Process sequence steps every 30 seconds for more punctual timing
cron.schedule('* * * * *', async () => {
  await processSequenceSteps();
  // Run again after 30s for better precision (cron only supports 1min minimum)
  setTimeout(() => processSequenceSteps(), 30000);
});

// Auto-check Gmail for replies every 30 seconds
let _gmailCheckRunning = false;

// Function to check Gmail
async function checkGmailAutomatic() {
  if (_gmailCheckRunning || _sequenceProcessing) {
    console.log('⏭️ Skipping Gmail check — another job is running');
    return;
  }
  _gmailCheckRunning = true;
  try {
    await db.read();

    // Check all users with Gmail OAuth configured
    const gmailSettings = (db.data.email_settings || []).filter(s => s.provider === 'gmail' && s.access_token);

    for (const settings of gmailSettings) {
      try {
        console.log(`🔄 Auto-checking emails for user ${settings.user_id}...`);
        const newReplies = await checkGmailReplies(settings, settings.user_id);

        if (newReplies.length > 0) {
          console.log(`✉️  Found ${newReplies.length} new replies for user ${settings.user_id}`);
        }

        settings.last_checked = new Date().toISOString();
        await db.write();
      } catch (userError) {
        console.error(`Error checking emails for user ${settings.user_id}:`, userError.message);
      }
    }
  } catch (error) {
    console.error('Auto email check error:', error);
  } finally {
    _gmailCheckRunning = false;
  }
}

// Run every 1 minute, then again after 30 seconds (0-30sec latency)
cron.schedule('* * * * *', async () => {
  await checkGmailAutomatic();
  // Run again after 30s for faster email detection
  setTimeout(checkGmailAutomatic, 30000);
});

// Proactively refresh Gmail tokens every 5 minutes — prevents mid-send token expiry
cron.schedule('*/5 * * * *', async () => {
  await refreshAllGmailTokens();
});

// Also run immediately on startup to catch any tokens that expired while server was down
setTimeout(() => refreshAllGmailTokens(), 5000);

app.listen(PORT, () => {
  console.log(`✅ Backend server running on http://localhost:${PORT}`);
  console.log(`✅ API ready at http://localhost:${PORT}/api`);
});
