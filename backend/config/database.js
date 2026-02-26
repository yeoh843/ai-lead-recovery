import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Persistent database with file storage
class PersistentDB {
  constructor() {
    this.users = this.loadData('users') || [];
    this.leads = this.loadData('leads') || [];
    this.sequences = this.loadData('sequences') || [];
    this.sequenceSteps = this.loadData('sequenceSteps') || [];
    this.emailInteractions = this.loadData('emailInteractions') || [];
    this.aiDecisions = this.loadData('aiDecisions') || [];
  }

  loadData(collection) {
    const filePath = path.join(DATA_DIR, `${collection}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error(`Error loading ${collection}:`, error.message);
    }
    return null;
  }

  saveData(collection, data) {
    const filePath = path.join(DATA_DIR, `${collection}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      console.log(`💾 Saved ${collection} to ${filePath}`);
    } catch (error) {
      console.error(`❌ Error saving ${collection}:`, error.message);
    }
  }

  // Helper to generate IDs
  generateId() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  // Users
  async createUser(userData) {
    const user = {
      id: this.generateId(),
      ...userData,
      ai_automation_enabled: false, // Default to false for safety
      auto_send_all: false, // Option to bypass all approvals
      created_at: new Date().toISOString()
    };
    this.users.push(user);
    this.saveData('users', this.users);
    return user;
  }

  async findUserByEmail(email) {
    return this.users.find(u => u.email === email);
  }

  async findUserById(id) {
    return this.users.find(u => u.id === id);
  }

  async updateUserSettings(id, settings) {
    const index = this.users.findIndex(u => u.id === id);
    if (index !== -1) {
      this.users[index] = {
        ...this.users[index],
        ...settings,
        updated_at: new Date().toISOString()
      };
      this.saveData('users', this.users);
      return this.users[index];
    }
    return null;
  }

  // Leads
  async createLead(leadData) {
    const lead = {
      id: this.generateId(),
      status: 'new',
      ai_intent: null,
      objection_subtype: null,
      decision_recommendation: null,
      auto_send_enabled: true, // Default to true for new leads
      current_step: 0,
      ...leadData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.leads.push(lead);
    this.saveData('leads', this.leads);
    return lead;
  }

  async getLeads(userId, filters = {}) {
    let leads = this.leads.filter(l => l.user_id === userId);

    if (filters.status) {
      leads = leads.filter(l => l.status === filters.status);
    }

    if (filters.ai_intent) {
      leads = leads.filter(l => l.ai_intent === filters.ai_intent);
    }

    return leads;
  }

  async findLeadById(id) {
    return this.leads.find(l => l.id === id);
  }

  async findLeadByEmail(email) {
    return this.leads.find(l => l.email === email);
  }

  async updateLead(id, updates) {
    const index = this.leads.findIndex(l => l.id === id);
    if (index !== -1) {
      this.leads[index] = {
        ...this.leads[index],
        ...updates,
        updated_at: new Date().toISOString()
      };
      this.saveData('leads', this.leads);
      return this.leads[index];
    }
    return null;
  }

  async deleteLead(id) {
    const index = this.leads.findIndex(l => l.id === id);
    if (index !== -1) {
      this.leads.splice(index, 1);
      this.saveData('leads', this.leads);
      return true;
    }
    return false;
  }

  // Sequences
  async createSequence(sequenceData) {
    const sequence = {
      id: this.generateId(),
      is_active: true,
      ...sequenceData,
      created_at: new Date().toISOString()
    };
    this.sequences.push(sequence);
    this.saveData('sequences', this.sequences);
    return sequence;
  }

  async getSequences(userId) {
    return this.sequences.filter(s => s.user_id === userId);
  }

  async findSequenceById(id) {
    return this.sequences.find(s => s.id === id);
  }

  async updateSequence(id, updates) {
    const index = this.sequences.findIndex(s => s.id === id);
    if (index !== -1) {
      this.sequences[index] = { ...this.sequences[index], ...updates };
      this.saveData('sequences', this.sequences);
      return this.sequences[index];
    }
    return null;
  }

  async deleteSequence(id) {
    const index = this.sequences.findIndex(s => s.id === id);
    if (index !== -1) {
      this.sequences.splice(index, 1);
      this.saveData('sequences', this.sequences);
      return true;
    }
    return false;
  }

  // Sequence Steps
  async createSequenceStep(stepData) {
    const step = {
      id: this.generateId(),
      ...stepData,
      created_at: new Date().toISOString()
    };
    this.sequenceSteps.push(step);
    this.saveData('sequenceSteps', this.sequenceSteps);
    return step;
  }

  async getSequenceSteps(sequenceId) {
    return this.sequenceSteps
      .filter(s => s.sequence_id === sequenceId)
      .sort((a, b) => a.step_number - b.step_number);
  }

  // Email Interactions
  async createEmailInteraction(interactionData) {
    const interaction = {
      id: this.generateId(),
      ...interactionData,
      created_at: new Date().toISOString()
      // Supports fields: lead_id, direction ('sent'/'received'), subject, body, message_id (for threading),
      // in_reply_to (parent message ID), references (chain of message IDs), sent_at, replied_at, etc.
    };
    this.emailInteractions.push(interaction);
    this.saveData('emailInteractions', this.emailInteractions);
    return interaction;
  }

  async getEmailInteractions(leadId) {
    return this.emailInteractions.filter(i => i.lead_id === leadId);
  }

  // AI Decisions
  async createAIDecision(decisionData) {
    const decision = {
      id: this.generateId(),
      ...decisionData,
      created_at: new Date().toISOString()
    };
    this.aiDecisions.push(decision);
    this.saveData('aiDecisions', this.aiDecisions);
    return decision;
  }

  // Analytics
  async getAnalytics(userId) {
    const userLeads = this.leads.filter(l => l.user_id === userId);
    const userSequences = this.sequences.filter(s => s.user_id === userId);
    
    const statusCounts = userLeads.reduce((acc, lead) => {
      acc[lead.status] = (acc[lead.status] || 0) + 1;
      return acc;
    }, {});

    const intentCounts = userLeads.reduce((acc, lead) => {
      if (lead.ai_intent) {
        acc[lead.ai_intent] = (acc[lead.ai_intent] || 0) + 1;
      }
      return acc;
    }, {});

    const totalInteractions = this.emailInteractions.filter(i => 
      userLeads.some(l => l.id === i.lead_id)
    );

    const sentEmails = totalInteractions.filter(i => i.direction === 'sent').length;
    const receivedReplies = totalInteractions.filter(i => i.direction === 'received').length;
    const replyRate = sentEmails > 0 ? ((receivedReplies / sentEmails) * 100).toFixed(1) : 0;

    return {
      overview: {
        total_leads: userLeads.length,
        active_sequences: userSequences.filter(s => s.is_active).length,
        reply_rate: parseFloat(replyRate),
        recovered_this_month: statusCounts.converted || 0
      },
      funnel: statusCounts,
      intent_distribution: intentCounts,
      hot_leads: userLeads
        .filter(l => l.ai_intent === 'INTERESTED')
        .slice(0, 5)
        .map(l => ({
          id: l.id,
          first_name: l.first_name,
          last_name: l.last_name,
          company: l.company,
          email: l.email
        }))
    };
  }
}

// Export singleton instance
export const db = new PersistentDB();

// For production, use PostgreSQL
export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;
