import OpenAI from 'openai';
import { db } from '../config/database.js';

const openai = process.env.OPENAI_API_KEY 
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * AI Lead Processor - Intelligent Lead Classification & Action System
 * 
 * Automatically processes new leads and decides:
 * - Lead profile & classification
 * - Intent & urgency level
 * - Best first action
 * - Follow-up strategy
 */
export class AILeadProcessor {
  
  /**
   * Main processing function - takes raw lead, returns intelligent analysis
   */
  async processNewLead(leadInput, businessContext = {}) {
    const {
      lead_source,
      name,
      email,
      company,
      message,
      form_answers,
      context
    } = leadInput;

    const {
      product_info = 'ZeroTouch Mail AI & Email Follow-up System',
      user_goal = 'recover lost leads and book sales calls',
      industry = 'SaaS',
      typical_deal_size = '$500-5000',
      sales_cycle_length = '7-30 days'
    } = businessContext;

    // If OpenAI is available, use advanced AI processing
    if (openai) {
      return await this.aiProcessLead(leadInput, businessContext);
    }

    // Otherwise use rule-based fallback
    return this.ruleBasedProcessLead(leadInput, businessContext);
  }

  /**
   * AI-Powered Lead Processing (GPT-4)
   */
  async aiProcessLead(leadInput, businessContext) {
    const prompt = this.buildProcessingPrompt(leadInput, businessContext);

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          {
            role: "system",
            content: "You are an expert sales lead analyst. You process new leads and make intelligent decisions about how to handle them. Always respond with valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);

      // Log the AI decision
      await this.logProcessingDecision({
        input: leadInput,
        output: result,
        method: 'ai',
        model: 'gpt-4-turbo-preview',
        tokens: response.usage.total_tokens
      });

      return result;

    } catch (error) {
      console.error('AI Lead Processing Error:', error);
      // Fallback to rule-based
      return this.ruleBasedProcessLead(leadInput, businessContext);
    }
  }

  /**
   * Build the AI processing prompt
   */
  buildProcessingPrompt(leadInput, businessContext) {
    const {
      lead_source,
      name,
      email,
      company,
      message,
      form_answers,
      context
    } = leadInput;

    const {
      product_info,
      user_goal,
      industry,
      typical_deal_size,
      sales_cycle_length
    } = businessContext;

    return `A new lead has just entered the system.
Your job is to automatically:
1. Validate and normalize the lead data
2. Build a structured lead profile
3. Classify the lead's current state
4. Decide the correct first follow-up action
5. Output machine-readable JSON only

---
INPUT DATA:

Lead Source: ${lead_source}
Name: ${name || 'Unknown'}
Email: ${email}
Company: ${company || 'Not provided'}
Message/Context: ${message || form_answers || context || 'No message provided'}

Business Context:
- Product: ${product_info}
- User Goal: ${user_goal}
- Industry: ${industry}
- Deal Size: ${typical_deal_size}
- Sales Cycle: ${sales_cycle_length}

---
YOU MUST ANALYZE AND OUTPUT:

A) Clean & Enrich the Lead:
- Normalize name, company, email
- Infer possible role, intent, and buying stage
- Extract pain points if present in message

B) Create Lead Profile:
- lead_type: inbound | outbound | old | abandoned | warm | cold
- intent_level: high | medium | low | unknown
- buying_stage: unaware | problem-aware | solution-aware | ready | not-now
- urgency: high | medium | low
- risk_factors: Array of potential issues (ghosting, price-sensitive, info-only, etc.)

C) Decide System State:
- status: new | active | stalled | revived | converted | dead
- recommended_strategy: nurture | close | revive | qualify

D) Decide First Action:
Choose ONE: send_first_email | wait | ask_question | qualify_lead | schedule_followup | mark_low_priority

E) Generate Initial Follow-up Plan:
- email_goal: What should the first email achieve?
- tone: professional | casual | urgent | consultative
- key_points: Array of points to mention
- objections_to_prepare: Array of likely objections
- personalization_hooks: What specific details to reference

---
IMPORTANT RULES:

1. If lead_source is "form" or "booking" → likely HIGH intent
2. If message contains pricing/demo requests → VERY HIGH intent
3. If lead_source is "old" or "csv" → likely LOW intent, needs warming
4. If company is recognizable/large → potentially higher value
5. If message is vague or generic → risk of ghosting
6. Consider urgency based on message tone and context

---
OUTPUT FORMAT (JSON ONLY):

{
  "cleaned_data": {
    "full_name": "John Doe",
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@acme.com",
    "company": "Acme Inc",
    "inferred_role": "Marketing Manager",
    "inferred_company_size": "50-200 employees"
  },
  "lead_profile": {
    "lead_type": "inbound",
    "intent_level": "high",
    "buying_stage": "solution-aware",
    "urgency": "high",
    "risk_factors": ["none"],
    "pain_points": ["struggling with lead follow-up", "losing deals to competitors"],
    "opportunity_score": 85
  },
  "system_state": {
    "status": "new",
    "recommended_strategy": "close",
    "priority": "high"
  },
  "first_action": {
    "action": "send_first_email",
    "delay_minutes": 0,
    "reasoning": "High intent lead asking about pricing - strike while hot"
  },
  "followup_plan": {
    "email_goal": "Provide pricing and schedule demo call",
    "tone": "professional",
    "key_points": [
      "Address their specific pain point about lead follow-up",
      "Mention how we helped similar companies",
      "Clear pricing information",
      "Easy scheduling link"
    ],
    "objections_to_prepare": ["price concerns", "feature comparison questions"],
    "personalization_hooks": [
      "Reference their company name",
      "Mention their specific use case from message"
    ],
    "suggested_subject": "Re: Your Lead Recovery Question",
    "estimated_close_probability": 0.65
  },
  "ai_confidence": 0.92,
  "processing_notes": "Lead shows strong buying signals with specific product questions"
}

ANALYZE AND RESPOND WITH JSON NOW:`;
  }

  /**
   * Rule-Based Lead Processing (Fallback when no AI)
   */
  ruleBasedProcessLead(leadInput, businessContext) {
    const {
      lead_source,
      name,
      email,
      company,
      message,
      form_answers,
      context
    } = leadInput;

    // Extract first and last name
    const nameParts = (name || '').trim().split(' ');
    const first_name = nameParts[0] || 'Friend';
    const last_name = nameParts.slice(1).join(' ') || '';

    // Analyze message for intent signals
    const fullMessage = (message || form_answers || context || '').toLowerCase();
    
    const highIntentKeywords = ['pricing', 'price', 'cost', 'demo', 'trial', 'buy', 'purchase', 'how much', 'when can', 'schedule', 'book', 'call'];
    const mediumIntentKeywords = ['interested', 'more info', 'learn more', 'tell me', 'curious', 'wondering'];
    const lowIntentKeywords = ['just looking', 'maybe', 'thinking', 'eventually', 'future'];

    const hasHighIntent = highIntentKeywords.some(keyword => fullMessage.includes(keyword));
    const hasMediumIntent = mediumIntentKeywords.some(keyword => fullMessage.includes(keyword));
    const hasLowIntent = lowIntentKeywords.some(keyword => fullMessage.includes(keyword));

    // Determine intent level
    let intent_level = 'unknown';
    let buying_stage = 'problem-aware';
    let urgency = 'medium';
    
    if (hasHighIntent) {
      intent_level = 'high';
      buying_stage = 'ready';
      urgency = 'high';
    } else if (hasMediumIntent) {
      intent_level = 'medium';
      buying_stage = 'solution-aware';
      urgency = 'medium';
    } else if (hasLowIntent) {
      intent_level = 'low';
      buying_stage = 'problem-aware';
      urgency = 'low';
    }

    // Determine lead type based on source
    let lead_type = 'inbound';
    if (['csv', 'crm', 'old'].includes(lead_source)) {
      lead_type = 'cold';
    } else if (['form', 'booking', 'dm'].includes(lead_source)) {
      lead_type = 'warm';
    }

    // Decide first action
    let first_action = 'send_first_email';
    let delay_minutes = 0;
    
    if (intent_level === 'high') {
      first_action = 'send_first_email';
      delay_minutes = 0; // Immediate
    } else if (intent_level === 'low' || lead_type === 'cold') {
      first_action = 'send_first_email';
      delay_minutes = 60; // Wait 1 hour to not seem too eager
    }

    // Calculate opportunity score
    let opportunity_score = 50; // Base score
    if (intent_level === 'high') opportunity_score += 30;
    if (intent_level === 'medium') opportunity_score += 15;
    if (company) opportunity_score += 10;
    if (fullMessage.length > 50) opportunity_score += 5;

    return {
      cleaned_data: {
        full_name: name || email.split('@')[0],
        first_name,
        last_name,
        email,
        company: company || null,
        inferred_role: null,
        inferred_company_size: null
      },
      lead_profile: {
        lead_type,
        intent_level,
        buying_stage,
        urgency,
        risk_factors: intent_level === 'low' ? ['low-engagement', 'ghosting-risk'] : ['none'],
        pain_points: [],
        opportunity_score
      },
      system_state: {
        status: 'new',
        recommended_strategy: intent_level === 'high' ? 'close' : 'nurture',
        priority: intent_level === 'high' ? 'high' : 'medium'
      },
      first_action: {
        action: first_action,
        delay_minutes,
        reasoning: `${intent_level} intent lead from ${lead_source}`
      },
      followup_plan: {
        email_goal: intent_level === 'high' 
          ? 'Schedule demo and provide pricing' 
          : 'Build relationship and educate',
        tone: intent_level === 'high' ? 'professional' : 'consultative',
        key_points: [
          'Address their inquiry',
          'Provide relevant value',
          'Clear next step'
        ],
        objections_to_prepare: ['pricing', 'timing'],
        personalization_hooks: company ? [`Reference ${company}`] : ['Use their name'],
        suggested_subject: `Re: ${lead_source === 'form' ? 'Your Inquiry' : 'Following Up'}`,
        estimated_close_probability: intent_level === 'high' ? 0.45 : 0.15
      },
      ai_confidence: 0.65,
      processing_notes: 'Rule-based processing (AI not available)'
    };
  }

  /**
   * Log processing decision for analytics
   */
  async logProcessingDecision(data) {
    try {
      await db.createAIDecision({
        decision_type: 'lead_processing',
        input_data: data.input,
        output_data: data.output,
        model_used: data.model || 'rule-based',
        tokens_used: data.tokens || 0,
        processing_time_ms: Date.now()
      });
    } catch (error) {
      console.error('Error logging processing decision:', error);
    }
  }

  /**
   * Update lead with processing results
   */
  async updateLeadWithProcessing(leadId, processingResult) {
    const { cleaned_data, lead_profile, system_state } = processingResult;

    await db.updateLead(leadId, {
      // Update cleaned data
      first_name: cleaned_data.first_name,
      last_name: cleaned_data.last_name,
      company: cleaned_data.company,
      
      // Store profile data in metadata
      metadata: {
        inferred_role: cleaned_data.inferred_role,
        company_size: cleaned_data.inferred_company_size,
        lead_type: lead_profile.lead_type,
        intent_level: lead_profile.intent_level,
        buying_stage: lead_profile.buying_stage,
        urgency: lead_profile.urgency,
        opportunity_score: lead_profile.opportunity_score,
        pain_points: lead_profile.pain_points,
        risk_factors: lead_profile.risk_factors
      },
      
      // Update system state
      status: system_state.status,
      intent_level: lead_profile.intent_level.toUpperCase(),
      
      // Store processing result
      processing_result: processingResult
    });

    return processingResult;
  }
}

export const aiLeadProcessor = new AILeadProcessor();
