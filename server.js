const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- CONFIG ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_MINUTES) || 5) * 60 * 1000;

const replyStore = {};
const notifiedReplies = new Set();

// --- HELPERS ---

function telegramUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

// Strip HTML tags and escape special chars so Telegram doesn't choke
function sanitize(str) {
  if (!str) return "";
  if (typeof str !== "string") str = JSON.stringify(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim()
    .slice(0, 1000);
}

async function sendTelegram(text) {
  const res = await axios.post(telegramUrl("sendMessage"), {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
  });
  return res.data.result;
}

// --- POLLING ---

async function pollInstantly() {
  console.log(`[${new Date().toISOString()}] Polling Instantly...`);

  let emails = [];
  try {
    const res = await axios.get("https://api.instantly.ai/api/v2/emails", {
      headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` },
      params: {
        email_type: "received",
        limit: 50,
        sort_order: "desc",
      },
    });
    emails = res.data?.items || [];
    console.log(`[${new Date().toISOString()}] Found ${emails.length} replies`);
  } catch (err) {
    console.error("Instantly fetch error:", err.response?.data || err.message);
    return; // bail early, don't crash
  }

  for (const email of emails) {
    const replyId = email.id;
    if (!replyId || notifiedReplies.has(replyId)) continue;

    // Mark as notified FIRST - so even if Telegram send fails, we don't retry infinitely
    notifiedReplies.add(replyId);

    const leadEmail = sanitize(email.from_address || "Unknown");
    const leadName = sanitize(email.from_name || email.from_address || "Unknown");
    const fromInbox = sanitize(email.eaccount || email.to_address || "Unknown inbox");
    const campaignName = sanitize(email.campaign_name || "Unknown campaign");
    const subject = sanitize(email.subject || "(no subject)");
    const body = sanitize(email.body || email.preview || "(no body)");

    const message = [
      `<b>📨 New Reply</b>`,
      ``,
      `<b>From:</b> ${leadName} (${leadEmail})`,
      `<b>Inbox:</b> ${fromInbox}`,
      `<b>Campaign:</b> ${campaignName}`,
      `<b>Subject:</b> ${subject}`,
      ``,
      `<b>Message:</b>`,
      body,
      ``,
      `<i>Use Telegram Reply to respond to ${leadEmail}</i>`,
    ].join("\n");

    try {
      const sentMsg = await sendTelegram(message);
      replyStore[sentMsg.message_id] = {
        lead_email: email.from_address,
        from_inbox: email.eaccount || email.to_address,
        email_id: replyId,
        subject: email.subject,
        campaign_name: email.campaign_name,
      };
      console.log(`[${new Date().toISOString()}] Notified: ${email.from_address}`);
    } catch (err) {
      console.error(`Telegram send error for ${email.from_address}:`, err.response?.data || err.message);
    }
  }
}

// --- TELEGRAM WEBHOOK ---

app.post("/telegram-webhook", async (req, res) => {
  res.status(200).json({ ok: true });

  const message = req.body?.message;
  if (!message || !message.text) return;

  const replyTo = message.reply_to_message;
  if (!replyTo) {
    await sendTelegram("To respond to a lead, use Telegram's <b>Reply</b> feature on the notification message.").catch(() => {});
    return;
  }

  const context = replyStore[replyTo.message_id];
  if (!context) {
    await sendTelegram("⚠️ Could not find lead context. Server may have restarted since this notification.").catch(() => {});
    return;
  }

  try {
    await axios.post(
      "https://api.instantly.ai/api/v2/emails/reply",
      {
        reply_to_uuid: context.email_id,
        eaccount: context.from_inbox,
        to_address: context.lead_email,
        subject: `Re: ${context.subject}`,
        body: message.text.trim(),
      },
      { headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` } }
    );
    await sendTelegram(`✅ Reply sent to <b>${sanitize(context.lead_email)}</b> from <b>${sanitize(context.from_inbox)}</b>`).catch(() => {});
    console.log(`[${new Date().toISOString()}] Reply sent to ${context.lead_email}`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error("Reply send error:", detail);
    await sendTelegram(`❌ Failed to reply to ${sanitize(context.lead_email)}\n\n${sanitize(JSON.stringify(detail))}`).catch(() => {});
  }
});

// --- HEALTH CHECK ---
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    notified_count: notifiedReplies.size,
    stored_contexts: Object.keys(replyStore).length,
    poll_interval_minutes: POLL_INTERVAL_MS / 60000,
  });
});

// --- START ---
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setTimeout(() => pollInstantly().catch(console.error), 2000);
  setInterval(() => pollInstantly().catch(console.error), POLL_INTERVAL_MS);
});
