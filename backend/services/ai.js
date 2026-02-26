import OpenAI from 'openai';
import { db } from '../config/database.js';

const openai = process.env.OPENAI_API_KEY 
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export class AIService {
  /**
   * Detects the intent of a lead's reply
   */
  async detectIntent(replyText, subject = '', leadContext = {}) {
    // If OpenAI is not configured, use fallback
    if (!openai) {
      return this.fallbackIntentDetection(replyText, subject);
    }

    const subjectLine = subject ? `Subject: "${subject}"\n` : '';

    const prompt = `You are an expert sales assistant analyzing lead responses.

${subjectLine}Reply: "${replyText}"

Use BOTH the subject line and reply body to determine intent. The subject can reveal tone, urgency, or context that the body alone may not show.

Classify into ONE category:
1. INTERESTED - wants to move forward, asking about product/pricing
2. NOT_NOW - interested but wrong timing
3. OBJECTION - has concerns or doubts
4. GHOSTING - vague, non-committal
5. DEAD - clear rejection

Return JSON only:
{
  "category": "INTERESTED",
  "confidence": 0.95,
  "reasoning": "brief explanation",
  "suggested_action": "what to do next",
  "key_phrases": ["relevant phrases"],
  "urgency_score": 8
}`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [
          { role: "system", content: "You are an expert sales assistant." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);

      // Log AI decision
      await db.createAIDecision({
        decision_type: 'intent_detection',
        input_data: { subject, reply: replyText },
        output_data: result,
        model_used: 'gpt-4-turbo-preview',
        tokens_used: response.usage.total_tokens
      });

      return result;
    } catch (error) {
      console.error('AI Intent Detection Error:', error.message);
      return this.fallbackIntentDetection(replyText, subject);
    }
  }

  /**
   * Generates personalized email using AI
   */
  async generatePersonalizedEmail(lead, template, inboundContext = null) {
    // If OpenAI is not configured, use fallback
    if (!openai) {
      return this.fallbackPersonalization(lead, template);
    }

    const inboundSection = inboundContext
      ? `\nLead's Last Email:
Subject: "${inboundContext.subject || '(no subject)'}"
Body: "${inboundContext.body || ''}"

Your reply should directly address their subject line and message above.\n`
      : '';

    const replyStyleRules = inboundContext
      ? `\nFIRST REPLY RULES (strictly follow these):
- Your ONLY goal in this first reply is to get a response from the lead — NOT to sell.
- Acknowledge their inquiry in 1 short sentence.
- Then ask ONE qualifying question to understand their needs better.
  Good qualifying questions: preferred area/location, property type (condo/landed/commercial), move-in timeline, or number of rooms needed.
  Choose whichever is most obviously missing from their message.
- Do NOT list multiple properties or full specs in this reply.
- If you must mention a property, mention ONE at most as a brief teaser (e.g. "I do have a freehold landed in Kajang around that range").
- Keep the entire reply body under 60 words.
- End with your single qualifying question — make it easy to answer.
- Tone: friendly, conversational, human. Not corporate. Not salesy.\n`
      : '';

    const prompt = `You are an expert sales copywriter for a real estate agent.

Lead: ${lead.first_name} ${lead.last_name}
Status: ${lead.status}
${inboundSection}${replyStyleRules}
Template (use as reference for tone and agent signature only):
${template}

Rewrite to be highly personalized.${inboundContext ? ' Follow the FIRST REPLY RULES above strictly.' : ' Keep under 150 words, conversational tone, clear CTA.'}

Return JSON:
{
  "subject": "...",
  "body": "..."
}`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        response_format: { type: "json_object" }
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.error('AI Email Generation Error:', error.message);
      return this.fallbackPersonalization(lead, template);
    }
  }

  /**
   * Fallback intent detection using keywords
   */
  fallbackIntentDetection(text, subject = '') {
    const lowerText = (text + ' ' + subject).toLowerCase();

    // Check for clear rejection
    if (
      lowerText.includes('not interested') ||
      lowerText.includes('remove me') ||
      lowerText.includes('unsubscribe') ||
      lowerText.includes('stop emailing')
    ) {
      return {
        category: 'DEAD',
        confidence: 0.9,
        reasoning: 'Clear rejection phrases detected',
        suggested_action: 'stop_all_sequences',
        key_phrases: ['not interested'],
        urgency_score: 1
      };
    }

    // Check for interest
    if (
      lowerText.includes('pricing') ||
      lowerText.includes('how much') ||
      lowerText.includes('demo') ||
      lowerText.includes('call') ||
      lowerText.includes('schedule')
    ) {
      return {
        category: 'INTERESTED',
        confidence: 0.7,
        reasoning: 'Buying signal phrases detected',
        suggested_action: 'notify_user_immediately',
        key_phrases: ['pricing', 'demo'],
        urgency_score: 9
      };
    }

    // Check for timing issues
    if (
      lowerText.includes('later') ||
      lowerText.includes('next month') ||
      lowerText.includes('not right now')
    ) {
      return {
        category: 'NOT_NOW',
        confidence: 0.75,
        reasoning: 'Timing delay indicators',
        suggested_action: 'schedule_long_term_followup',
        key_phrases: ['later', 'next month'],
        urgency_score: 3
      };
    }

    // Check for objections
    if (
      lowerText.includes('expensive') ||
      lowerText.includes('too much') ||
      lowerText.includes('not sure')
    ) {
      return {
        category: 'OBJECTION',
        confidence: 0.7,
        reasoning: 'Objection phrases detected',
        suggested_action: 'send_objection_handler',
        key_phrases: ['expensive'],
        urgency_score: 6
      };
    }

    // Default to ghosting
    return {
      category: 'GHOSTING',
      confidence: 0.5,
      reasoning: 'No clear signals detected',
      suggested_action: 'continue_sequence',
      key_phrases: [],
      urgency_score: 4
    };
  }

  /**
   * Fallback personalization (simple variable replacement)
   */
  fallbackPersonalization(lead, template) {
    const subject = template.subject || 'Following up';
    const body = template.body || template;

    return {
      subject: subject.replace(/\{\{first_name\}\}/g, lead.first_name),
      body: body
        .replace(/\{\{first_name\}\}/g, lead.first_name)
        .replace(/\{\{last_name\}\}/g, lead.last_name)
        .replace(/\{\{company\}\}/g, lead.company || 'your company')
        .replace(/\{\{email\}\}/g, lead.email)
    };
  }
}

export const aiService = new AIService();
