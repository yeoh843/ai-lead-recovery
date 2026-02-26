# ⚡ Gmail Push Notifications Setup Guide

This guide enables **instant email delivery** instead of polling every 5 minutes. Emails will arrive in **milliseconds** instead of minutes!

## Current Status
- ✅ Code updated
- ✅ Endpoints ready
- ⏳ Google Cloud Pub/Sub setup (this guide)

---

## Step 1: Install Google Cloud SDK

### Windows (Recommended):
```bash
# Download and install from:
# https://cloud.google.com/sdk/docs/install#windows

# Or using Chocolatey:
choco install google-cloud-sdk

# Verify installation:
gcloud --version
```

### After installation:
```bash
# Authenticate with your Google account
gcloud auth login

# Set your project
gcloud config set project recovery-lead
```

---

## Step 2: Enable Required APIs

Run these commands to enable the necessary Google Cloud APIs:

```bash
# Enable Gmail API (already done, but confirm):
gcloud services enable gmail.googleapis.com

# Enable Cloud Pub/Sub API:
gcloud services enable pubsub.googleapis.com
```

---

## Step 3: Create Pub/Sub Topic and Subscription

Run these commands in your terminal:

```bash
# 1. Create the Pub/Sub topic for Gmail notifications
gcloud pubsub topics create gmail-notifications

# 2. Create a service account (for Pub/Sub to authenticate)
gcloud iam service-accounts create gmail-push-service \
  --display-name="Gmail Push Notifications Service"

# 3. Get your GCP project number (you'll need this):
gcloud projects describe recovery-lead --format='value(projectNumber)'
# Save this number! It looks like: 123456789012

# 4. Create a subscription that will push to your webhook
# Replace YOUR_PROJECT_NUMBER with the number from step 3:
gcloud pubsub subscriptions create gmail-inbox-sub \
  --topic=gmail-notifications \
  --push-endpoint=https://YOUR-DOMAIN.com/api/webhooks/gmail-push \
  --push-auth-service-account=gmail-push-service@recovery-lead.iam.gserviceaccount.com

# 5. Grant necessary permissions:
gcloud projects add-iam-policy-binding recovery-lead \
  --member=serviceAccount:gmail-push-service@recovery-lead.iam.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

---

## Step 4: Update Your Domain

In the command above, replace `YOUR-DOMAIN.com` with your actual domain:

- **Local development**: `http://localhost:3000`
- **Production**: `https://yourdomain.com`

**For local testing**, you can use ngrok to expose your local server:

```bash
# Install ngrok from: https://ngrok.com/download
# Then run:
ngrok http 3000

# This gives you a public URL like: https://abc123.ngrok.io
# Use this in the subscription creation command
```

---

## Step 5: Enable Gmail Push in Your App

Once everything is set up, click this button in your settings:

```
POST /api/emails/enable-push
```

Or use curl:

```bash
curl -X POST http://localhost:3000/api/emails/enable-push \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

---

## Step 6: Test It!

1. Send an email to your Gmail account
2. Wait for the instant notification (within 1-2 seconds)
3. Check your app - the email should appear immediately
4. Check the server logs for: `🔔 ⚡ INSTANT EMAIL NOTIFICATION`

---

## Speed Comparison

| Method | Latency | Status |
|--------|---------|--------|
| **Old: 5-min polling** | 0-5 minutes | ❌ DISABLED |
| **New: Gmail Push** | **100-500ms** | ✅ ENABLED |

---

## Troubleshooting

### "Project not found" error
```bash
# Make sure you're using the correct project:
gcloud config set project recovery-lead
gcloud config get-value project  # Should show: recovery-lead
```

### "Permission denied" error
```bash
# Make sure your service account has correct permissions:
gcloud projects get-iam-policy recovery-lead \
  --flatten="bindings[].members" \
  --filter="bindings.members:gmail-push-service*"
```

### Webhook not receiving notifications
1. Check that your domain/ngrok URL is correct in the subscription
2. Verify your server is running and accessible
3. Check logs: `gcloud logging read "resource.type=pubsub_subscription"`
4. Try sending a test message:
```bash
gcloud pubsub topics publish gmail-notifications \
  --message='{"emailAddress":"test@gmail.com","historyId":"123"}'
```

### "No subscription found"
```bash
# List all subscriptions:
gcloud pubsub subscriptions list

# If not there, recreate it (see Step 3)
```

---

## Auto-Renewal (Important!)

Gmail Push Notifications expire after **7 days**. Your system should auto-renew them.

To manually renew:
```bash
POST /api/emails/enable-push
```

Or set up a cron job to call this endpoint every 6 days.

---

## Next Steps

Once Gmail Push is working:
1. ✅ Instant emails (done!)
2. ⏳ Optional: Set up failure fallback to polling
3. ⏳ Optional: Monitor Pub/Sub metrics

---

## Support

If you get stuck:
- Google Cloud Pub/Sub: https://cloud.google.com/pubsub/docs
- Gmail Push Notifications: https://developers.google.com/gmail/api/guides/push
- Check server logs for errors

Happy instant emailing! 🚀
