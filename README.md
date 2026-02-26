# 🥇 ZeroTouch Mail AI & Revenue Follow-Up System

> **An AI-powered system that automatically follows up, understands replies, and recovers lost leads until they convert.**

## 🎯 What This Does

- **Automatically follows up** with leads who filled forms, DMed, or went cold
- **AI understands replies** (interested, not now, objection, ghosting, dead)
- **Smart routing** - pauses sequences when leads reply positively
- **Recovers revenue** by preventing leads from slipping through the cracks

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ installed
- Git (optional)

### Installation

1. **Download or clone this repository**

```bash
# If using git
git clone <repository-url>
cd ai-lead-recovery
```

2. **Set up the backend**

```bash
cd backend
npm install
cp .env.example .env
```

3. **Edit `.env` file** (optional but recommended)

```bash
# Add your OpenAI API key for better AI features (optional)
OPENAI_API_KEY=sk-your-key-here

# Change the JWT secret
JWT_SECRET=your-random-secret-key-here
```

4. **Start the backend server**

```bash
npm run dev
```

The API will start on `http://localhost:3000`

5. **Open the frontend** (in a new terminal or browser)

Simply open `frontend/index.html` in your browser, or serve it with a local server:

```bash
cd frontend
python3 -m http.server 8080
# Then open http://localhost:8080
```

---

## 📖 Usage Guide

### 1. Sign Up / Login

- Open the frontend in your browser
- Create an account with your email and password
- Login to access the dashboard

### 2. Add Your First Lead

**Option A: Manual Entry**
- Go to the "Leads" tab
- Click "+ Add Lead"
- Fill in the lead details (email is required)
- Click "Add Lead"

**Option B: Via Webhook** (for integration with forms)
```bash
POST http://localhost:3000/api/webhooks/leads/YOUR_USER_ID
Content-Type: application/json

{
  "email": "john@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "company": "Acme Inc",
  "source": "landing_page"
}
```

**Option C: CSV Import** (via API)
```bash
POST http://localhost:3000/api/leads/import
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "leads": [
    {
      "email": "john@example.com",
      "first_name": "John",
      "last_name": "Doe",
      "company": "Acme Inc"
    }
  ]
}
```

### 3. Create an Email Sequence

- Go to the "Sequences" tab
- Click "+ Create Sequence"
- Name your sequence (e.g., "Standard 7-Day Follow-Up")
- Add steps with delay days and email templates
- Use variables like `{{first_name}}`, `{{company}}` in templates
- Click "Create Sequence"

**Example 3-Step Sequence:**

**Step 1** (Day 0):
```
Hi {{first_name}},

I noticed you downloaded our guide. Quick question - are you currently struggling with lead follow-up?

We help companies like {{company}} recover leads that slip through the cracks.

Worth a quick chat?
```

**Step 2** (Day 3):
```
{{first_name}},

Following up on my email from earlier this week.

Here's a quick case study from a company similar to {{company}}: [link]

Want to see how this could work for you?
```

**Step 3** (Day 7 - Breakup):
```
{{first_name}},

Haven't heard back, so I'm guessing timing isn't great.

Should I close your file?

If there's still interest, just reply and we'll chat.
```

### 4. Enroll Leads in Sequence

**Via API:**
```bash
POST http://localhost:3000/api/leads/:lead_id/enroll
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "sequence_id": "sequence_id_here"
}
```

The system will:
1. Send the first email immediately
2. Schedule follow-ups based on your delays
3. Stop automatically if they reply (and AI detects intent)

### 5. Monitor the Dashboard

- View total leads, reply rates, and recovered leads
- See "Hot Leads" who showed interest
- Track AI-detected intents (INTERESTED, NOT_NOW, OBJECTION, etc.)

---

## 🤖 How the AI Works

### AI Intent Detection

When a lead replies, the AI analyzes their message and categorizes it:

- **INTERESTED** → Pauses sequence, notifies you immediately
- **NOT_NOW** → Schedules long-term follow-up (45 days)
- **OBJECTION** → Sends objection-handling email
- **GHOSTING** → Continues sequence
- **DEAD** → Stops all emails

### AI Email Personalization

The AI rewrites your templates to be more personalized:
- References the lead's company
- Adjusts tone based on context
- Makes it sound human, not robotic

**Note:** If you don't have an OpenAI API key, the system uses fallback logic based on keywords (still works, just less intelligent).

---

## 🔧 Configuration

### Environment Variables

Create a `.env` file in the `backend/` directory:

```bash
# Server
NODE_ENV=development
PORT=3000

# JWT Secret (CHANGE THIS!)
JWT_SECRET=your-super-secret-jwt-key

# OpenAI API (optional - for better AI)
OPENAI_API_KEY=sk-your-openai-key

# Email Service (optional - for production)
# SENDGRID_API_KEY=SG.your-sendgrid-key
# FROM_EMAIL=sales@yourcompany.com
```

### Email Sending (Production)

Currently, emails are **logged but not sent** (demo mode).

To actually send emails, integrate SendGrid or Postmark:

1. Sign up for SendGrid (free tier available)
2. Get your API key
3. Add to `.env`:
```bash
SENDGRID_API_KEY=SG.your-key
FROM_EMAIL=sales@yourcompany.com
```

4. Uncomment the SendGrid code in `backend/services/email.js`

---

## 📊 API Documentation

### Authentication

**Register**
```
POST /api/auth/register
{
  "email": "user@example.com",
  "password": "password123",
  "company_name": "Acme Inc"
}
```

**Login**
```
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "password123"
}

Response: { "token": "jwt_token", "user": {...} }
```

### Leads

**Get All Leads**
```
GET /api/leads
Authorization: Bearer YOUR_TOKEN
```

**Create Lead**
```
POST /api/leads
Authorization: Bearer YOUR_TOKEN
{
  "email": "john@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "company": "Acme Inc"
}
```

**Enroll in Sequence**
```
POST /api/leads/:id/enroll
Authorization: Bearer YOUR_TOKEN
{
  "sequence_id": "sequence_id"
}
```

### Sequences

**Get All Sequences**
```
GET /api/sequences
Authorization: Bearer YOUR_TOKEN
```

**Create Sequence**
```
POST /api/sequences
Authorization: Bearer YOUR_TOKEN
{
  "name": "Standard Follow-Up",
  "description": "7-day sequence",
  "steps": [
    {
      "delay_days": 0,
      "email_template": "Hi {{first_name}}..."
    },
    {
      "delay_days": 3,
      "email_template": "Following up..."
    }
  ]
}
```

### Analytics

**Get Dashboard**
```
GET /api/analytics/dashboard
Authorization: Bearer YOUR_TOKEN
```

### Webhooks

**New Lead Webhook**
```
POST /api/webhooks/leads/:userToken
{
  "email": "john@example.com",
  "first_name": "John",
  "source": "landing_page"
}
```

**Inbound Email** (for reply processing)
```
POST /api/webhooks/inbound-email
{
  "from": "john@example.com",
  "subject": "Re: Your email",
  "text": "Yes, I'm interested in pricing"
}
```

---

## 🧪 Testing the System

### Test AI Intent Detection

```bash
curl -X POST http://localhost:3000/api/webhooks/inbound-email \
-H "Content-Type: application/json" \
-d '{
  "from": "test@example.com",
  "subject": "Re: Your email",
  "text": "What is your pricing?"
}'
```

The AI should detect this as **INTERESTED**.

### Test Email Sequence

1. Create a lead
2. Create a sequence with 0 day delay for first email
3. Enroll the lead
4. Check the backend console - you'll see the email being "sent" (logged)
5. Check the dashboard - analytics should update

---

## 🚧 Current Limitations (MVP)

- **Emails are not actually sent** (demo mode) - integrate SendGrid for production
- **In-memory database** - data resets when server restarts
- **No user authentication on webhooks** - add token validation in production
- **Single-user optimized** - works best for solo founders/small teams
- **AI requires OpenAI API key** - uses fallback keyword matching otherwise

---

## 🔮 Roadmap / Future Features

- [ ] Persistent database (PostgreSQL)
- [ ] Real email sending (SendGrid integration)
- [ ] SMS follow-ups
- [ ] LinkedIn integration
- [ ] A/B testing sequences
- [ ] Advanced analytics dashboard
- [ ] Team collaboration features
- [ ] Mobile app
- [ ] White-label option

---

## 🐛 Troubleshooting

### Backend won't start

**Error:** `Cannot find module...`
- **Fix:** Run `npm install` in the backend directory

**Error:** `Port 3000 already in use`
- **Fix:** Change `PORT=3001` in `.env` or kill the process using port 3000

### Frontend can't connect to backend

**Error:** Network error or CORS issues
- **Fix:** Make sure backend is running on `http://localhost:3000`
- **Fix:** Check browser console for errors

### AI not working

**Issue:** AI always returns basic keyword matching
- **Fix:** Add your OpenAI API key to `.env`
- **Note:** The fallback still works, just less intelligent

### Emails not sending

**Issue:** Emails logged but not received
- **Fix:** This is expected in demo mode
- **Solution:** Integrate SendGrid API (see Configuration section)

---

## 💡 Tips for Best Results

1. **Keep email templates under 150 words**
2. **Use natural, conversational tone**
3. **Test sequences with your own email first**
4. **Monitor hot leads daily** (check dashboard)
5. **Adjust delays based on your industry** (B2B = longer delays)
6. **Use personalization variables** (`{{first_name}}`, `{{company}}`)

---

## 📜 License

MIT License - feel free to use this for your business!

---

## 🤝 Support

For issues or questions:
1. Check this README
2. Review the code comments
3. Check browser/backend console for errors

---

## 🎉 You're All Set!

You now have a working ZeroTouch Mail AI system. Start by:
1. Creating your account
2. Adding test leads
3. Creating a simple 3-step sequence
4. Enrolling leads and watching the magic happen!

**Remember:** This is an MVP. The real power comes from:
- Connecting real email (SendGrid)
- Adding your actual leads
- Refining sequences based on reply rates
- Letting the AI do the heavy lifting

Good luck recovering those lost leads! 🚀
