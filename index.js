// index.js — 360dialog <-> Chatwoot con media, contactos y "Abierto"
// Optimizado para latencia + push_event: true para forzar actualización instantánea en Chatwoot

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');

let cors;
try { cors = require('cors'); } catch { cors = () => (_req, _res, next) => next(); }

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cors());

// ========= CONFIG =========
const CHATWOOT_API_TOKEN = '5ZSLaX4VCt4T2Z1aHRyPmTFb';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv904439.hstgr.cloud/api/v1/accounts';

const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = '7Ll0YquMGVElHWxofGvhi5oFAK';

const N8N_WEBHOOK_URL = 'https://n8n.srv876216.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

// ========= AXIOS =========
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 10_000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 10_000 });

const AX = axios.create({
  timeout: 12_000,
  httpAgent,
  httpsAgent,
  validateStatus: s => s >= 200 && s < 500
});

const AX_INSECURE = axios.create({
  timeout: 8_000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  validateStatus: s => s >= 200 && s < 500
});

// ========= UTIL =========
function normalizarNumero(numero) {
  if (!numero || typeof numero !== 'string') return '';
  if (numero.startsWith('+52') && !numero.startsWith('+521')) return '+521' + numero.slice(3);
  return numero;
}
function j(v){ try{ return typeof v==='string'?v:JSON.stringify(v);}catch(_){ return String(v);} }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========== Anti-duplicados ==========
const processedMessages = new Map(); // id -> timestamp
function seen(id) {
  const now = Date.now();
  if (processedMessages.has(id)) return true;
  processedMessages.set(id, now);
  if (processedMessages.size > 3000) {
    for (const [k, ts] of processedMessages) if (now - ts > 1000 * 60 * 30) processedMessages.delete(k);
  }
  return false;
}

// ========== Cache ==========
const convCache = new Map(); // phone -> { contactId, sourceId, conversationId, ts }
const CACHE_TTL_MS = 1000 * 60 * 15;

function getFromCache(phone) {
  const it = convCache.get(phone);
  if (it && (Date.now() - it.ts) < CACHE_TTL_MS) return it;
  convCache.delete(phone);
  return null;
}
function setCache(phone, data) {
  convCache.set(phone, { ...data, ts: Date.now() });
}

// ====== Chatwoot helpers ======
async function searchContact(identifier) {
  try {
    const { data, status } = await AX.get(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(identifier)}`,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    if (status >= 200 && status < 300) return data.payload?.[0] || null;
  } catch (_) {}
  return null;
}

async function createContact(identifier, name = 'Cliente WhatsApp') {
  try {
    const payload = { inbox_id: CHATWOOT_INBOX_ID, name, identifier, phone_number: identifier };
    const { data, status } = await AX.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`,
      payload,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    if (status >= 200 && status < 300) return data.payload;
  } catch (err) {}
  return null;
}

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = phone;
  const found = await searchContact(identifier);
  if (found?.id) return found;
  const created = await createContact(identifier, name);
  if (created?.id) return created;
  return await searchContact(identifier);
}

async function getSourceId(contactId) {
  try {
    const { data } = await AX.get(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}`,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    return data.payload.contact_inboxes?.[0]?.source_id || '';
  } catch (err) {
    console.error('❌ No se pudo obtener source_id:', j(err.response?.data) || err.message);
    return '';
  }
}

async function getOrCreateConversation(contactId, sourceId) {
  try {
    const { data, status } = await AX.get(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    if (status >= 200 && status < 300 && Array.isArray(data.payload) && data.payload.length > 0) {
      return data.payload[0].id;
    }
  } catch (_) {}
  for (let i = 0, wait = 250; i < 4; i++, wait = Math.min(wait * 2, 1500)) {
    try {
      const resp = await AX.post(
        `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`,
        { source_id: sourceId, inbox_id: CHATWOOT_INBOX_ID },
        { headers: { api_access_token: CHATWOOT_API_TOKEN } }
      );
      const id = resp.data?.id;
      if (id) return id;
    } catch (err) {
      const s = err.response?.status;
      if (s && s >= 500) await sleep(wait);
      else break;
    }
  }
  return null;
}

// Reintentos al guardar texto con push_event
async function sendToChatwoot(conversationId, type, content, outgoing = false, maxRetries = 4) {
  const payload = { 
    message_type: outgoing ? 'outgoing' : 'incoming', 
    private: false, 
    push_event: true // 👈 fuerza broadcast
  };
  if (['image', 'document', 'audio', 'video'].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else {
    payload.content = content;
  }
  let wait = 250, lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { data, status } = await AX.post(
        `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        payload,
        { headers: { api_access_token: CHATWOOT_API_TOKEN } }
      );
      if (status >= 200 && status < 300) return data.id;
      throw new Error(`CW ${status}: ${j(data)}`);
    } catch (err) {
      const s = err.response?.status;
      const retriable = s === 404 || s === 422 || s === 409 || s >= 500;
      lastErr = j(err.response?.data) || err.message;
      if (!retriable) break;
      await sleep(wait);
      wait = Math.min(wait * 1.8, 2000);
    }
  }
  throw new Error(`sendToChatwoot failed: ${lastErr}`);
}

// Subir adjunto binario a Chatwoot con push_event
async function sendAttachmentToChatwoot(conversationId, buffer, filename, mime, outgoing = false) {
  const form = new FormData();
  form.append('message_type', outgoing ? 'outgoing' : 'incoming');
  form.append('private', 'false');
  form.append('push_event', 'true'); // 👈 también en adjuntos
  form.append('attachments[]', buffer, { filename, contentType: mime });

  const headers = { ...form.getHeaders(), 'api_access_token': CHATWOOT_API_TOKEN };
  const { data, status } = await AX.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    form,
    { headers, maxBodyLength: Infinity, maxContentLength: Infinity }
  );
  if (status >= 200 && status < 300) return data.id;
  throw new Error(`Adjunto CW ${status}: ${j(data)}`);
}

// ========= ENDPOINTS =========
app.get('/health', (_req, res) => res.status(200).send('ok'));

// 1) Entrantes (360dialog -> Chatwoot)
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const entry   = req.body.entry?.[0];
      const changes = entry?.changes?.[0]?.value;
      const msgs = changes?.messages || [];
      const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
      const name = changes?.contacts?.[0]?.profile?.name;
      const phone = normalizarNumero(rawPhone);

      if (!phone || !msgs.length) return;

      let cache = getFromCache(phone);
      if (!cache) {
        const contact = await findOrCreateContact(phone, name || 'Cliente WhatsApp');
        if (!contact?.id) return;
        const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
        if (!sourceId) return;
        const conversationId = await getOrCreateConversation(contact.id, sourceId);
        if (!conversationId) return;
        cache = { contactId: contact.id, sourceId, conversationId };
        setCache(phone, cache);
      }

      for (const msg of msgs) {
        if (!msg || msg.from_me) continue;
        const inboundId = msg.id;
        if (seen(inboundId)) continue;

        const type = msg.type;
        if (type === 'text') {
          await sendToChatwoot(cache.conversationId, 'text', msg.text.body, false);
        } else if (['image', 'document', 'audio', 'video', 'sticker'].includes(type)) {
          await sendToChatwoot(cache.conversationId, 'text', `📎 Recibido ${type}…`, false);
          const mediaObj = msg[type] || {};
          const mediaId  = mediaObj.id;
          const caption  = mediaObj.caption || '';
          (async () => {
            try {
              const { buffer, mime } = await fetch360MediaBinary(mediaId);
              const fname = filenameFor(type, mediaId, mime, mediaObj);
              await sendAttachmentToChatwoot(cache.conversationId, buffer, fname, mime, false);
              if (caption) await sendToChatwoot(cache.conversationId, 'text', caption, false);
            } catch (e) {
              console.error(`❌ No se pudo subir media:`, e.message);
            }
          })();
        } else if (type === 'location') {
          const loc = msg.location;
          const locStr = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
          await sendToChatwoot(cache.conversationId, 'text', locStr, false);
        } else {
          await sendToChatwoot(cache.conversationId, 'text', '[Contenido no soportado]', false);
        }
      }
    } catch (err) {
      console.error('❌ Webhook error:', err.message);
    }
  });
});

// 2) Salientes desde Chatwoot -> WhatsApp
app.post('/outbound', async (req, res) => {
  try {
    const msg = req.body;
    if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
      return res.sendStatus(200);
    }
    const cwMsgId   = msg.id;
    const rawNumber = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
    const number    = normalizarNumero(`+${rawNumber}`).replace('+', '');
    const content   = msg.content;

    if (seen(cwMsgId)) return res.sendStatus(200);
    if (!number || !content) return res.sendStatus(200);

    console.log(`📤 Enviando a WhatsApp: ${number} | ${content}`);
    const r = await AX.post(D360_API_URL, {
      messaging_product: 'whatsapp',
      to: number,
      type: 'text',
      text: { body: content }
    }, {
      headers: { 'D360-API-KEY': D360_API_KEY, 'Content-Type': 'application/json' }
    });

    if (r.status >= 200 && r.status < 300) return res.sendStatus(200);
    console.error('❌ WhatsApp no-2xx:', r.status, j(r.data));
    return res.sendStatus(500);
  } catch (err) {
    console.error('❌ outbound error:', err.message);
    res.sendStatus(500);
  }
});

// 3) Reflejo desde Streamlit -> Chatwoot
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    const normalizedPhone = normalizarNumero(String(phone || '').trim());
    console.log('📥 Reflejando mensaje desde Streamlit:', { phone: normalizedPhone, name, content });

    let cache = getFromCache(normalizedPhone);
    if (!cache) {
      const contact = await findOrCreateContact(normalizedPhone, name || 'Cliente WhatsApp');
      if (!contact?.id) return res.status(500).send('No se pudo crear/recuperar contacto');
      const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
      if (!sourceId) return res.status(500).send('No se pudo obtener source_id');
      const conversationId = await getOrCreateConversation(contact.id, sourceId);
      if (!conversationId) return res.status(500).send('No se pudo crear conversación');
      cache = { contactId: contact.id, sourceId, conversationId };
      setCache(normalizedPhone, cache);
    }

    const messageId = await sendToChatwoot(cache.conversationId, 'text', `${content}[streamlit]`, true);
    return res.status(200).json({ ok: true, messageId, conversationId: cache.conversationId });
  } catch (err) {
    console.error('❌ send-chatwoot-message error:', err.message);
    res.status(500).send('Error interno');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
