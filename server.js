const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- CONFIG ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY; // V2 API key
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_MINUTES) || 5) * 60 * 1000;

// In-memory store: maps Telegram message_id -> reply context
const replyStore = {};

// Track already-notified reply IDs so we don't double-notify
const notifiedReplies = new Set();

// --- HELPERS ---

function telegramUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendTelegram(text) {
  const res = await axios.post(telegramUrl("sendMessage"), {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
  });
  return res.data.result;
}

// --- POLLING: fetch replies from Instantly V2 API ---

async function pollInstantly() {
  console.log(`[${new Date().toISOString()}] Polling Instantly for new replies...`);

  try {
    const res = await axios.get("https://api.instantly.ai/api/v2/emails", {
      headers: {
        Authorization: `Bearer ${INSTANTLY_API_KEY}`,
      },
      params: {
        email_type: "received",   // only inbound replies
        i_status: 1,              // 1 = Interested
        limit: 50,
        sort_order: "desc",
      },
    });

    const emails = res.data?.items || [];
    console.log(`[${new Date().toISOString()}] Found ${emails.length} interested replies`);

    for (const email of emails) {
      const replyId = email.id;
      if (notifiedReplies.has(replyId)) continue;

      const leadEmail = email.from_address || "Unknown";
      const leadName = email.from_name || leadEmail;
      const fromInbox = email.eaccount || email.to_address || "Unknown inbox";
      const campaignName = email.campaign_name || "Unknown campaign";
      const subject = email.subject || "(no subject)";
      const body = (email.body || email.preview || "").trim().slice(0, 1000);

      const message = [
        `<b>📨 Positive Reply Received</b>`,
        ``,
        `<b>From:</b> ${leadName} (${leadEmail})`,
        `<b>Inbox:</b> ${fromInbox}`,
        `<b>Campaign:</b> ${campaignName}`,
        `<b>Subject:</b> ${subject}`,
        ``,
        `<b>Message:</b>`,
        body,
        ``,
        `<i>Reply to this message in Telegram to respond to ${leadEmail}</i>`,
      ].join("\n");

      const sentMsg = await sendTelegram(message);

      replyStore[sentMsg.message_id] = {
        lead_email: leadEmail,
        from_inbox: fromInbox,
        email_id: replyId,
        subject,
        campaign_name: campaignName,
      };

      notifiedReplies.add(replyId);
      console.log(`[${new Date().toISOString()}] Notified: reply from ${leadEmail}`);
    }
  } catch (err) {
    console.error("Polling error:", err.response?.data || err.message);
  }
}

// --- TELEGRAM WEBHOOK: your replies back to leads ---

app.post("/telegram-webhook", async (req, res) => {
  const update = req.body;
  res.status(200).json({ ok: true });

  const message = update.message;
  if (!message || !message.text) return;

  const replyTo = message.reply_to_message;
  if (!replyTo) {
    await sendTelegram(
      "To respond to a lead, use Telegram's <b>Reply</b> feature on the notification message."
    );
    return;
  }

  const context = replyStore[replyTo.message_id];
  if (!context) {
    await sendTelegram(
      "⚠️ Could not find the original lead context. It may have expired (server restart clears memory)."
    );
    return;
  }

  const replyText = message.text.trim();

  try {
    await axios.post(
      "https://api.instantly.ai/api/v2/emails/reply",
      {
        reply_to_uuid: context.email_id,
        eaccount: context.from_inbox,
        to_address: context.lead_email,
        subject: `Re: ${context.subject}`,
        body: replyText,
      },
      {
        headers: {
          Authorization: `Bearer ${INSTANTLY_API_KEY}`,
        },
      }
    );

    await sendTelegram(
      `✅ Reply sent to <b>${context.lead_email}</b> from <b>${context.from_inbox}</b>`
    );

    console.log(`[${new Date().toISOString()}] Sent reply to ${context.lead_email}`);
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    console.error("Reply error:", errorDetail);
    await sendTelegram(
      `❌ Failed to send reply to ${context.lead_email}.\n\nError: ${JSON.stringify(errorDetail)}`
    );
  }
});

// --- HEALTH CHECK ---
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    stored_contexts: Object.keys(replyStore).length,
    notified_replies: notifiedReplies.size,
    poll_interval_minutes: POLL_INTERVAL_MS / 60000,
  });
});

// --- START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  pollInstantly();
  setInterval(pollInstantly, POLL_INTERVAL_MS);
});
