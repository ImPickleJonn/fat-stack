// Fat Stack — Express server with Telegram Stars IAP + bot notifications.
// Serves the static game (single index.html) and exposes a small API for
// buying SKUs via Telegram Stars (currency XTR). Game state lives in the
// browser's localStorage; the server only handles money flow and notifications.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
// Deterministic secret derived from BOT_TOKEN so /api/setup-webhook can
// register it with Telegram and the webhook handler can verify the same
// value back. Anyone with the bot token can compute this (acceptable).
const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32)
  : null;

app.use(express.json({ limit: '512kb' }));

// ============ Stars SKUs ============
// All prices are in Telegram Stars (XTR). priceUsd is approximate, surfaced
// for client-side display only — Telegram charges the user in Stars.
const SKUS = {
  revive: {
    id: 'revive',
    title: 'Revive · Continue',
    description: 'One revive — keep your run going.',
    price: 30,
    priceUsd: '$0.39',
    grant: { revives: 1 },
  },
  hint_pack: {
    id: 'hint_pack',
    title: 'Hint Pack · 5 Hints',
    description: 'Highlights the best slot for the next 5 placements.',
    price: 60,
    priceUsd: '$0.79',
    grant: { hints: 5 },
  },
  gems_small: {
    id: 'gems_small',
    title: 'Small Pile · 500 Gems',
    description: '500 gems to spend on revives, hints, and skins.',
    price: 99,
    priceUsd: '$1.29',
    grant: { gems: 500 },
  },
  starter_pack: {
    id: 'starter_pack',
    title: 'Starter Pack · Best Value',
    description: '1,500 gems + 3 revives + Neon skin.',
    price: 199,
    priceUsd: '$2.59',
    grant: { gems: 1500, revives: 3, skins: ['neon'] },
  },
  gems_big: {
    id: 'gems_big',
    title: 'Big Vault · 3,500 Gems',
    description: '3,500 gems — better gems-per-star ratio.',
    price: 399,
    priceUsd: '$5.19',
    grant: { gems: 3500 },
  },
  gems_mega: {
    id: 'gems_mega',
    title: 'Mega Vault · 12,000 Gems',
    description: '12,000 gems — best value.',
    price: 750,
    priceUsd: '$9.99',
    grant: { gems: 12000 },
  },
  no_bust: {
    id: 'no_bust',
    title: 'No-Bust Insurance',
    description: 'Free revive next time you get stuck this run.',
    price: 50,
    priceUsd: '$0.65',
    grant: { noBust: 1 },
  },
  skin_neon: {
    id: 'skin_neon',
    title: 'Neon Skin',
    description: 'Glowing tiles + dark board.',
    price: 150,
    priceUsd: '$1.99',
    grant: { skins: ['neon'] },
  },
  skin_wood: {
    id: 'skin_wood',
    title: 'Wood Skin',
    description: 'Classic wooden blocks on a soft tabletop.',
    price: 150,
    priceUsd: '$1.99',
    grant: { skins: ['wood'] },
  },
  battle_pass: {
    id: 'battle_pass',
    title: 'Season Pass · 30 Days',
    description: 'Daily quest rewards x2, exclusive skin, and gem bonus.',
    price: 500,
    priceUsd: '$6.49',
    grant: { battlePass: 30 },
  },
};

// Pending purchase queue per user — webhook pushes successful payments here,
// client drains via /api/poll-purchases after openInvoice resolves to 'paid'.
// In-memory: lost on restart. Restart-between-pay-and-poll is unlikely; for
// real production, persist to a DB.
const pendingByUser = new Map();
function pushPending(userId, sku) {
  if (!SKUS[sku]) return;
  if (!pendingByUser.has(userId)) pendingByUser.set(userId, []);
  pendingByUser.get(userId).push({ sku, grant: SKUS[sku].grant, ts: Date.now() });
}
function drainPending(userId) {
  const arr = pendingByUser.get(userId) || [];
  pendingByUser.delete(userId);
  return arr;
}

// Per-user state for outbound notifications (in-memory; lost on restart).
// Populated by /api/heartbeat (when the Mini App is open), the /start command,
// and successful_payment. Drives the notification cron below.
//   { chatId, lang, lastActiveAt, streak, streakRiskAt, notifLast, notifLastAny, notifTimes }
const userState = new Map();
function rememberUser(userId, patch) {
  if (!userId) return;
  const prev = userState.get(userId) || {};
  userState.set(userId, Object.assign(prev, patch));
}

// Validate Telegram initData per
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the decoded `user` object on success, null otherwise.
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (hash !== expectedHash) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) { return null; }
}

// Static — every file in this dir, with no-cache on .html so a redeploy is
// visible in Telegram WebView without forcing the user to clear caches.
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Canonical "where is this server reachable from?" helper.
function getPublicUrl() {
  const d = process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (!d) return '';
  return /^https?:\/\//i.test(d) ? d : 'https://' + d;
}
function buildPlayUrl() {
  return getPublicUrl() || 'http://localhost:' + PORT;
}

// ============ API ============
// Feature flags — client polls on boot.
app.get('/api/flags', (req, res) => {
  res.json({
    iap: !!BOT_TOKEN,
    publicUrl: getPublicUrl(),
  });
});

// Diagnostic — list available SKUs.
app.get('/api/skus', (req, res) => {
  res.json({
    enabled: !!BOT_TOKEN,
    skus: Object.values(SKUS).map(s => ({
      id: s.id, title: s.title, description: s.description,
      price: s.price, priceUsd: s.priceUsd, grant: s.grant,
    })),
  });
});

// Create a Stars invoice for a SKU. Client opens the returned link with
// Telegram.WebApp.openInvoice().
app.post('/api/create-invoice', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set on server' });
  const { sku, initData } = req.body || {};
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const item = SKUS[sku];
  if (!item) return res.status(400).json({ error: 'unknown sku' });
  // Payload travels with the invoice — Telegram echoes it back in the
  // successful_payment update so we know which user / SKU was paid.
  const payload = JSON.stringify({ uid: user.id, sku, ts: Date.now() });
  try {
    const r = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: item.title,
        description: item.description,
        payload,
        provider_token: '', // Empty string == Stars
        currency: 'XTR',
        prices: [{ label: item.title, amount: item.price }],
      }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(500).json({ error: data.description || 'telegram api failed' });
    res.json({ link: data.result });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// Heartbeat — called on app boot and periodically while the Mini App is open.
// Carries language + streak state so notifications can be localized + timed.
app.post('/api/heartbeat', (req, res) => {
  const { initData, lang, streak, streakRiskAt } = req.body || {};
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  rememberUser(user.id, {
    chatId: user.id,
    lang: lang || 'en',
    streak: streak || 0,
    streakRiskAt: streakRiskAt || null,
    lastActiveAt: Date.now(),
  });
  res.json({ ok: true });
});

// Client polls after openInvoice resolves to 'paid'. Drains pending grants.
app.post('/api/poll-purchases', (req, res) => {
  const { initData } = req.body || {};
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  res.json({ purchases: drainPending(user.id) });
});

// Telegram webhook — answers pre_checkout_query (must respond OK within 10s
// or Telegram cancels the payment), queues successful payments, and handles
// /start to capture the user's chat_id so the cron can message them later.
app.post('/api/telegram-webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(403).end();
  }
  const update = req.body || {};
  try {
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: q.id, ok: true }),
      });
    } else if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      try {
        const payload = JSON.parse(sp.invoice_payload);
        if (payload && payload.uid && SKUS[payload.sku]) {
          pushPending(payload.uid, payload.sku);
        }
      } catch (e) { /* malformed payload — ignore */ }
    } else if (update.message && update.message.text === '/start') {
      const m = update.message;
      const lang = (m.from && m.from.language_code) || 'en';
      rememberUser(m.from.id, { chatId: m.chat.id, lang, lastActiveAt: Date.now() });
      const playUrl = buildPlayUrl();
      const first = (m.from && (m.from.first_name || m.from.username)) || 'there';
      const isRu = lang.startsWith('ru');
      const welcomeText = isRu
        ? `Привет, ${first}! 🟧\n\n` +
          `*Fat Stack* — складывай блоки, собирай линии, бей рекорды.\n\n` +
          `🎯 *Как играть*\n` +
          `• Перетаскивай 3 фигуры на поле 8×8\n` +
          `• Заполняй ряды и колонки целиком — они исчезают\n` +
          `• Делай комбо подряд → больше очков\n` +
          `• Ежедневный челлендж и недельный турнир\n\n` +
          `Жми *PLAY* ниже. 🚀`
        : `Hey ${first}! 🟧\n\n` +
          `*Fat Stack* — drop blocks, clear lines, smash high scores.\n\n` +
          `🎯 *How to play*\n` +
          `• Drag the 3 pieces onto an 8×8 grid\n` +
          `• Fill any row or column to clear it\n` +
          `• Chain clears = combo multiplier\n` +
          `• Daily challenge + weekly tournament\n\n` +
          `Tap *PLAY* below to start. 🚀`;
      try {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: m.chat.id,
            text: welcomeText,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: isRu ? '🎮  И Г Р А Т Ь' : '🎮  P L A Y   F A T   S T A C K', web_app: { url: playUrl } },
              ]],
            },
          }),
        });
      } catch (e) {}
    }
  } catch (e) { /* don't let webhook errors crash the server */ }
  res.json({ ok: true });
});

// Diagnostic — Telegram's view of our webhook registration.
app.post('/api/webhook-info', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) {
    return res.status(403).json({ error: 'wrong setup key (must equal BOT_TOKEN)' });
  }
  try {
    const r = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// One-time webhook registration. Run once after BOT_TOKEN is set:
//   curl -X POST https://<your-domain>/api/setup-webhook -H "x-setup-key: <BOT_TOKEN>"
app.post('/api/setup-webhook', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) {
    return res.status(403).json({ error: 'wrong setup key (must equal BOT_TOKEN)' });
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/api/telegram-webhook`;
  try {
    const r = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['pre_checkout_query', 'message'],
        drop_pending_updates: true,
      }),
    });
    res.json({ webhook_url: url, telegram: await r.json() });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

// ============ Outbound notifications ============
// Localized notification copy per language (Russian-first; English fallback).
// Each kind has a set of variants; we pick one at random for variety.
const NOTIF_COPY = {
  streak_risk: {
    ru: [
      '🔥 Серия в опасности! Сыграй до полуночи, чтобы сохранить её.',
      '🔥 Не теряй серию — одна игра и она в безопасности.',
    ],
    en: [
      '🔥 Streak in danger! Play before midnight to keep it.',
      '🔥 Don\'t lose your streak — one quick game saves it.',
    ],
  },
  daily_challenge: {
    ru: [
      '🎯 Новый ежедневный челлендж ждёт. У тебя 24 часа!',
      '🎯 Сегодняшняя головоломка готова — попадёшь в топ?',
    ],
    en: [
      '🎯 Today\'s daily challenge is live. 24 hours on the clock!',
      '🎯 New daily puzzle is up — can you crack the leaderboard?',
    ],
  },
  comeback: {
    ru: [
      '👋 Давно не виделись! Загляни — тебя ждёт бонусный сундук.',
      '👋 Скучаем! Бесплатные гемы внутри.',
    ],
    en: [
      '👋 Been a while! Drop in for a comeback bonus chest.',
      '👋 We miss you! Free gems waiting inside.',
    ],
  },
};
const NOTIF_CTA = {
  ru: '🎮  И Г Р А Т Ь',
  en: '🎮  P L A Y   N O W',
};
function pickCopy(kind, lang) {
  const table = NOTIF_COPY[kind] || {};
  const variants = table[lang] || table.en || [];
  return variants[Math.floor(Math.random() * variants.length)] || '';
}
function ctaFor(lang) { return NOTIF_CTA[lang] || NOTIF_CTA.en; }

async function sendNotification(chatId, lang, kind) {
  if (!chatId || !BOT_TOKEN) return false;
  const text = pickCopy(kind, lang);
  if (!text) return false;
  const replyMarkup = {
    inline_keyboard: [[
      { text: ctaFor(lang), web_app: { url: buildPlayUrl() } },
    ]],
  };
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
    });
    return !!(await r.json()).ok;
  } catch (e) { return false; }
}

// Manual notification trigger for testing.
app.post('/api/debug-notify', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) return res.status(403).json({ error: 'wrong setup key' });
  const kind = (req.body && req.body.kind) || 'daily_challenge';
  const sent = [];
  for (const [uid, st] of userState) {
    const ok = await sendNotification(st.chatId, st.lang || 'en', kind);
    sent.push({ uid, ok });
  }
  res.json({ kind, sent, knownUsers: userState.size });
});

// ============ Notification rate limits ============
// Three gates, all enforced before any send:
//   1. Per-kind cooldown — at most one of each kind every 24h
//   2. Global spacing    — at least 6h between any two notifications
//   3. Daily cap         — at most 3 total notifications per 24h window
const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY  = 24 * 60 * 60 * 1000;
const NOTIF_PER_KIND_COOLDOWN_MS = ONE_DAY;
const NOTIF_MIN_SPACING_MS = 6 * ONE_HOUR;
const NOTIF_DAILY_CAP = 3;

function canSendNotif(st, kind, now) {
  const lastForKind = (st.notifLast || {})[kind] || 0;
  if (now - lastForKind < NOTIF_PER_KIND_COOLDOWN_MS) return false;
  const lastAny = st.notifLastAny || 0;
  if (now - lastAny < NOTIF_MIN_SPACING_MS) return false;
  st.notifTimes = (st.notifTimes || []).filter(t => now - t < ONE_DAY);
  if (st.notifTimes.length >= NOTIF_DAILY_CAP) return false;
  return true;
}
function recordNotifSent(st, kind, now) {
  st.notifLast = st.notifLast || {};
  st.notifLast[kind] = now;
  st.notifLastAny = now;
  st.notifTimes = (st.notifTimes || []).concat(now);
}

async function notifyLoop() {
  const now = Date.now();
  for (const [uid, st] of userState) {
    if (!st.chatId) continue;
    // Streak at risk: player has a streak and the deadline is in the next 4h
    // (and they're not currently in the app).
    if (st.streak > 0 && st.streakRiskAt && st.streakRiskAt > now && (st.streakRiskAt - now) < 4 * ONE_HOUR
        && (now - (st.lastActiveAt || 0)) > 30 * 60 * 1000
        && canSendNotif(st, 'streak_risk', now)) {
      const ok = await sendNotification(st.chatId, st.lang || 'en', 'streak_risk');
      if (ok) recordNotifSent(st, 'streak_risk', now);
      continue;
    }
    // Comeback: away for 3+ days.
    if (st.lastActiveAt && (now - st.lastActiveAt) > 3 * ONE_DAY && canSendNotif(st, 'comeback', now)) {
      const ok = await sendNotification(st.chatId, st.lang || 'en', 'comeback');
      if (ok) recordNotifSent(st, 'comeback', now);
      continue;
    }
    // Daily challenge: away 18+ hours since last seen, daily kind not yet sent.
    if (st.lastActiveAt && (now - st.lastActiveAt) > 18 * ONE_HOUR && canSendNotif(st, 'daily_challenge', now)) {
      const ok = await sendNotification(st.chatId, st.lang || 'en', 'daily_challenge');
      if (ok) recordNotifSent(st, 'daily_challenge', now);
    }
  }
}

// ============ Boot ============
app.listen(PORT, () => {
  console.log(`Fat Stack serving on port ${PORT}`);
  console.log(`IAP: ${BOT_TOKEN ? 'enabled' : 'DISABLED — set BOT_TOKEN env var to turn on'}`);
  if (BOT_TOKEN) {
    setInterval(notifyLoop, FIVE_MIN);
    console.log('[notify] loop armed — every 5 min');
  }
});
