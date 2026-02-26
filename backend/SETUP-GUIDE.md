# 🚀 ZeroTouch Mail AI - Complete Setup Guide

## ⚠️ IMPORTANT: This is the REAL system (Demo mode removed!)

---

## 📋 Step 1: Install Dependencies

```bash
cd "C:\recovery saas\ai-lead-recovery\backend"
npm install
```

This will install:
- nodemailer (send emails)
- imap (read emails)
- mailparser (parse emails)
- node-cron (auto-check emails every 5 min)
- dotenv (environment variables)

---

## 🔑 Step 2: Create .env File

1. Copy `.env.example` to `.env`
2. Add your keys:

```
JWT_SECRET=change-this-to-random-string
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

**Get Anthropic API Key (FREE $5 credit):**
1. Go to: https://console.anthropic.com/
2. Sign up
3. Go to API Keys
4. Create key
5. Paste in .env

---

## 📧 Step 3: Email Setup (Gmail Example)

### For Gmail (kengyuyeoh@gmail.com):

1. **Enable 2-Factor Authentication:**
   - Go to: https://myaccount.google.com/security
   - Turn on 2-Step Verification

2. **Create App Password:**
   - Go to: https://myaccount.google.com/apppasswords
   - Select app: "Mail"
   - Select device: "Other" (name it "ZeroTouch Mail AI")
   - Click "Generate"
   - Copy the 16-character password

3. **Email Settings in App:**
   - Email: kengyuyeoh@gmail.com
   - IMAP Host: imap.gmail.com
   - IMAP Port: 993
   - IMAP User: kengyuyeoh@gmail.com
   - IMAP Password: (paste app password)
   - SMTP Host: smtp.gmail.com
   - SMTP Port: 587
   - SMTP User: kengyuyeoh@gmail.com
   - SMTP Password: (same app password)

---

## 🚀 Step 4: Start Backend

```bash
npm start
```

You should see:
```
✅ Backend server running on http://localhost:3000
✅ Email auto-check enabled (every 5 minutes)
```

---

## 🎯 Step 5: Use The System

### A) Add Email Settings (First Time Only)
1. Open `index.html` in browser
2. Login/Register
3. Go to Settings (new menu item)
4. Add your email credentials
5. Click "Save Email Settings"
6. Click "Test Connection" to verify

### B) How Auto-Analysis Works
1. Someone replies to your email
2. System checks inbox every 5 minutes
3. AI analyzes reply automatically:
   - INTERESTED → Hot lead!
   - NOT_NOW → Follow up later
   - OBJECTION → Address concern
   - GHOSTING → Try new approach
   - DEAD → Stop following up
4. AI writes response draft
5. You review draft in "AI Drafts" page
6. Approve or edit → System sends email

### C) Auto-Send Mode (Optional)
1. Go to Settings
2. Enable "Auto-send for INTERESTED leads"
3. System will automatically send responses to hot leads
4. You still review other intents manually

---

## 📊 Features Now Working:

✅ Real email sending (SMTP)
✅ Auto-check inbox (IMAP, every 5 min)
✅ AI analyzes all replies automatically
✅ AI writes response drafts
✅ Review drafts before sending
✅ Auto-send hot leads (optional)
✅ Complete analytics dashboard
✅ Lead import (CSV/Excel/Paste)
✅ Dark mode toggle

---

## 🔧 Troubleshooting:

**"Email check failed":**
- Check app password is correct
- Make sure 2FA is enabled in Gmail
- Try "Allow less secure apps" (not recommended)

**"AI analysis not working":**
- Check ANTHROPIC_API_KEY in .env
- Make sure you have API credits

**"Can't send emails":**
- Verify SMTP settings
- Check firewall/antivirus isn't blocking port 587

---

## 🌐 Deploy to Production (Optional):

When ready for real users:
1. Deploy backend to Railway.app or Heroku
2. Get domain name
3. Update API_URL in frontend
4. Upload frontend to Netlify/Vercel

Cost: ~$5/month to start

---

## 💡 Next Steps:

1. Test with real email
2. Import your leads
3. Let AI analyze replies
4. Review and approve drafts
5. Watch your leads convert!

**Questions? Check the code comments or ask!**
