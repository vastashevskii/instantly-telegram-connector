const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- CONFIG (set these as environment variables) ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-this-secret";

// In-memory store: maps Telegram message_id -> reply context
// For production, replace with a small DB (e.g. Redis or SQLite)
const replyStore = {};

// --- HELPERS ---

function telegramUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendTelegram(text, replyMarkup = null) {
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await axios.post(telegramUrl("sendMessage"), payload);
  return res.data.result;
}

// --- ROUTE 1: Instantly webhook (incoming positive replies) ---
// Point your Instantly webhook to: https://your-server.com/instantly-webhook
// Add header: x-webhook-secret: <your WEBHOOK_SECRET>

app.post("/instantly-webhook", async (req, res) => {
  // Validate secret
  const secret = req.headers["x-webhook-secret"];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const event = req.body;

  // Instantly sends different event types - we only want reply events
  // Event type is usually "reply_received" or similar - adjust if needed
  // You can also filter by sentiment label if Instantly provides it
  const eventType = event.event_type || event.type || "";
  if (!eventType.toLowerCase().includes("reply")) {
    return res.status(200).json({ skipped: true });
  }

  // Extract fields from Instantly payload
  // Field names may vary slightly depending on your Instantly plan/version
  const {
    lead_email,
    lead_name,
    from_email,          // the inbox the reply came from (your sending address)
    campaign_name,
    subject,
    body,                // reply body text
    email_id,            // unique ID of this email thread
    reply_id,            // unique ID of the specific reply
    timestamp,
  } = event;

  // Format the Telegram notification
  const displayName = lead_name || lead_email || "Unknown sender";
  const displayInbox = from_email || "Unknown inbox";
  const displayCampaign = campaign_name || "Unknown campaign";
  const displaySubject = subject || "(no subject)";
  const displayBody = (body || "").trim().slice(0, 1000); // cap at 1000 chars

  const message = [
    `<b>📨 Positive Reply Received</b>`,
    ``,
    `<b>From:</b> ${displayName} (${lead_email})`,
    `<b>Inbox:</b> ${displayInbox}`,
    `<b>Campaign:</b> ${displayCampaign}`,
    `<b>Subject:</b> ${displaySubject}`,
    ``,
    `<b>Message:</b>`,
    displayBody,
    ``,
    `<i>Reply to this Telegram message to respond directly to ${lead_email}</i>`,
  ].join("\n");

  try {
    const sentMsg = await sendTelegram(message);

    // Store context so we can reply back later
    replyStore[sentMsg.message_id] = {
      lead_email,
      from_email,         // the inbox to send reply FROM
      email_id,
      reply_id,
      subject,
      campaign_name,
    };

    console.log(`[${new Date().toISOString()}] Notified Telegram for reply from ${lead_email}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to send Telegram message:", err.message);
    res.status(500).json({ error: "Failed to notify Telegram" });
  }
});

// --- ROUTE 2: Telegram webhook (your replies back to leads) ---
// Set your Telegram bot webhook to: https://your-server.com/telegram-webhook
// Run this once to register it:
// curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-server.com/telegram-webhook"

app.post("/telegram-webhook", async (req, res) => {
  const update = req.body;
  res.status(200).json({ ok: true }); // acknowledge immediately

  const message = update.message;
  if (!message || !message.text) return;

  // Only process replies (messages that reply to a previous bot message)
  const replyTo = message.reply_to_message;
  if (!replyTo) {
    // Not a reply - ignore or send help message
    await sendTelegram(
      "To respond to a lead, use Telegram's <b>Reply</b> feature on the notification message."
    );
    return;
  }

  const context = replyStore[replyTo.message_id];
  if (!context) {
    await sendTelegram(
      "⚠️ Could not find the original lead context for this reply. It may have expired (server restart clears memory)."
    );
    return;
  }

  const replyText = message.text.trim();

  // Send reply via Instantly API
  try {
    await axios.post(
      "https://api.instantly.ai/api/v1/emails/reply",
      {
        api_key: INSTANTLY_API_KEY,
        reply_to_email_id: context.email_id,    // thread to reply into
        from_email: context.from_email,          // send FROM the same inbox
        to_email: context.lead_email,
        subject: `Re: ${context.subject}`,
        body: replyText,
      }
    );

    await sendTelegram(
      `✅ Reply sent to <b>${context.lead_email}</b> from <b>${context.from_email}</b>`
    );

    console.log(`[${new Date().toISOString()}] Sent reply to ${context.lead_email} via ${context.from_email}`);
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    console.error("Failed to send reply via Instantly:", errorDetail);
    await sendTelegram(
      `❌ Failed to send reply to ${context.lead_email}.\n\nError: ${JSON.stringify(errorDetail)}`
    );
  }
});

// --- HEALTH CHECK ---
app.get("/", (req, res) => {
  res.json({ status: "ok", stored_contexts: Object.keys(replyStore).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Instantly-Telegram connector running on port ${PORT}`);
});
