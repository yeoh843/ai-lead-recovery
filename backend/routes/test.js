import express from 'express';
import { aiLeadProcessor } from '../services/lead-processor.js';

const router = express.Router();

/**
 * Test endpoint to see AI lead processing in action
 * No authentication needed - for demo purposes
 */
router.post('/test-ai-processor', async (req, res) => {
  try {
    const {
      name = 'John Doe',
      email = 'john@acme.com',
      company = 'Acme Inc',
      message = 'I need help with lead follow-up. What is your pricing?',
      source = 'form'
    } = req.body;

    console.log('\n🧪 TESTING AI LEAD PROCESSOR...\n');

    const result = await aiLeadProcessor.processNewLead(
      {
        lead_source: source,
        name,
        email,
        company,
        message
      },
      {
        product_info: 'ZeroTouch Mail AI & Email Follow-up System',
        user_goal: 'recover lost leads and book sales calls',
        industry: 'SaaS',
        typical_deal_size: '$500-5000',
        sales_cycle_length: '7-30 days'
      }
    );

    console.log('\n✅ AI PROCESSING COMPLETE!\n');
    console.log('📊 Results:');
    console.log(`   Intent Level: ${result.lead_profile.intent_level}`);
    console.log(`   Buying Stage: ${result.lead_profile.buying_stage}`);
    console.log(`   Urgency: ${result.lead_profile.urgency}`);
    console.log(`   Opportunity Score: ${result.lead_profile.opportunity_score}/100`);
    console.log(`   Recommended Action: ${result.first_action.action}`);
    console.log(`   Strategy: ${result.system_state.recommended_strategy}`);
    console.log('\n');

    res.json({
      success: true,
      input: {
        name,
        email,
        company,
        message,
        source
      },
      ai_analysis: result
    });

  } catch (error) {
    console.error('Test error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * Test different lead scenarios
 */
router.get('/test-scenarios', async (req, res) => {
  const scenarios = [
    {
      name: 'High Intent - Pricing Request',
      lead: {
        name: 'Sarah Johnson',
        email: 'sarah@techstartup.com',
        company: 'TechStartup Inc',
        message: 'Hi, we need a lead recovery solution ASAP. Can you send pricing for 1000 leads/month? Our current system is losing us deals.',
        source: 'form'
      }
    },
    {
      name: 'Medium Intent - Information Gathering',
      lead: {
        name: 'Mike Chen',
        email: 'mike@consulting.com',
        company: 'Chen Consulting',
        message: 'Interested in learning more about your platform. How does it work?',
        source: 'form'
      }
    },
    {
      name: 'Low Intent - Cold Lead',
      lead: {
        name: 'Jane Smith',
        email: 'jane@oldcompany.com',
        company: 'Old Company LLC',
        message: '',
        source: 'csv'
      }
    },
    {
      name: 'Abandoned Booking',
      lead: {
        name: 'Tom Rodriguez',
        email: 'tom@fastgrowth.io',
        company: 'FastGrowth.io',
        message: 'Started booking a demo but didn\'t finish',
        source: 'booking'
      }
    }
  ];

  const results = [];

  for (const scenario of scenarios) {
    const result = await aiLeadProcessor.processNewLead(
      {
        lead_source: scenario.lead.source,
        name: scenario.lead.name,
        email: scenario.lead.email,
        company: scenario.lead.company,
        message: scenario.lead.message
      },
      {
        product_info: 'ZeroTouch Mail AI System',
        user_goal: 'recover lost leads'
      }
    );

    results.push({
      scenario: scenario.name,
      lead: scenario.lead,
      analysis: {
        intent_level: result.lead_profile.intent_level,
        buying_stage: result.lead_profile.buying_stage,
        opportunity_score: result.lead_profile.opportunity_score,
        recommended_action: result.first_action.action,
        urgency: result.lead_profile.urgency
      }
    });
  }

  res.json({
    total_scenarios: scenarios.length,
    results
  });
});

export default router;
