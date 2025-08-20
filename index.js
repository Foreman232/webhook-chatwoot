// index.js – Webhook robusto (Render) con idempotencia + reintentos + ACK duro

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const app = express();
app.use(bodyParser.json());

// ============== CONFIG ==============
const CHATWOOT_API_TOKEN   = '5ZSLaX4VCt4T2Z1aHRyPmTFb';
const CHATWOOT_ACCOUNT_ID  = '1';
const CHATWOOT_INBOX_ID    = '1';
const BASE_URL             = 'https://srv904439.hstgr.cloud/api/v1/accounts';

const D360_API_URL         = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY         = '7Ll0YquMGVElHWxofGvhi5oFAK';

const N8N_WEBHOOK_URL      = 'https://n8n.srv876216.hstgr.cloud/webhook-test/confirmar-tarimas';
const PORT                 = process.env.PORT || 10000;

// ============== HELPERS ==============
function normalizarNumero(numero) {
  if (!numero || typeof numero !== 'string') return '';
  if (numero.startsWith('+52') && !numero.startsWith('+521')) return '+521' + numero.slice(3);
  return numero;
}
function makeExpiringSet(ms = 15 * 60 * 1000) {
  const map = new Map();
  return {
    has: k => {
      const t = map.get(k);
      if (!t) return false;
      if (Date.now() > t) { map.delete(k); return false; }
      return true;
    },
    add: k => map.set(k, Date.now() + ms),
  };
}
const processedInboundIds   = makeExpiringSet(); // 360dialog -> CW
const processedOutboundIds  = makeExpiringSet(); // CW -> 360dialog
const processedClientMsgIds = makeExpiringSet(); // Streamlit idempotencia

const cwHeaders = { api_access_token: CHATWOOT_API_TOKEN };

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = normalizarNumero(phone);
  const payload = { inbox_id: CHATWOOT_INBOX_ID, name, identifier, phone_number: identifier };
  try {
    const { data } = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, { headers: cwHeaders });
    return data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const q = encodeURIComponent(identifier);
      const { data } = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${q}`, { headers: cwHeaders });
      return data.payload?.[0];
    }
    console.error('❌ Contacto error:', err.response?.data || err.message);
    return null;
  }
}
async function getSourceId(contactId) {
  try {
    const { data } = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}`, { headers: cwHeaders });
    return data.payload.contact_inboxes?.[0]?.source_id || '';
  } catch (err) {
    console.error('❌ No se pudo obtener source_id:', err.response?.data || err.message);
    return '';
  }
}
async function getOrCreateConversation(contactId, sourceId) {
  try {
    const { data } = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, { headers: cwHeaders });
    if (Array.isArray(data.payload) && data.payload.length > 0) return data.payload[0].id;
    const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId, inbox_id: CHATWOOT_INBOX_ID
    }, { headers: cwHeaders });
    return resp.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.response?.data || err.message);
    return null;
  }
}
async function waitForConversationReady(conversationId, attempts = 3, delayMs = 350) {
  for (let i = 0; i < attempts; i++) {
    try {
      const check = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, { headers: cwHeaders });
      if (check.status === 200) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}
async function sendToChatwoot(conversationId, type, content, outgoing = false, maxRetries = 4) {
  const payload = { message_type: outgoing ? 'outgoing' : 'incoming', private: false };
  if (['image', 'document', 'audio', 'video'].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else { payload.content = content; }

  let wait = 400, lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { data } = await axios.post(
        `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        payload, { headers: cwHeaders }
      );
      return { ok: true, messageId: data.id };
    } catch (err) {
      const s = err.response?.status;
      const retriable = s === 404 || s === 422 || s === 409;
      lastErr = err.response?.data || err.message;
      if (!retriable) break;
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 2000);
    }
  }
  return { ok: false, error: lastErr };
}

// ===== 360dialog -> Chatwoot =====
app.post('/webhook', async (req, res) => {
  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
    const phone   = normalizarNumero(rawPhone);
    const name    = changes?.contacts?.[0]?.profile?.name;
    const msg     = changes?.messages?.[0];

    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const messageId = msg.id;
    if (processedInboundIds.has(messageId)) return res.sendStatus(200);
    processedInboundIds.add(messageId);

    const contact = await findOrCreateContact(phone, name);
    if (!contact?.id) return res.sendStatus(500);

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) return res.sendStatus(500);

    const conversationId = await getOrCreateConversation(contact.id, sourceId);
    if (!conversationId) return res.sendStatus(500);

    const type    = msg.type;
    const content = msg[type]?.body || msg[type]?.caption || msg[type]?.link || '[media]';

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body, false);
    } else if (['image', 'document', 'audio', 'video'].includes(type)) {
      await sendToChatwoot(conversationId, type, content, false);
    } else if (type === 'location') {
      const { latitude, longitude } = msg.location;
      await sendToChatwoot(conversationId, 'text', `📍 https://maps.google.com/?q=${latitude},${longitude}`, false);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]', false);
    }

    try {
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content }, { httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
    } catch (n8nErr) { console.error('❌ Error n8n:', n8nErr.message); }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ===== Chatwoot -> 360dialog =====
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
    return res.sendStatus(200);
  }

  const messageId = msg.id;
  if (processedOutboundIds.has(messageId)) return res.sendStatus(200);
  processedOutboundIds.add(messageId);

  const rawNumber = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const number    = normalizarNumero(`+${rawNumber}`).replace('+', '');
  const content   = msg.content;
  if (!number || !content) return res.sendStatus(200);

  try {
    await axios.post(D360_API_URL, {
      messaging_product: 'whatsapp',
      to: number,
      type: 'text',
      text: { body: content }
    }, { headers: { 'D360-API-KEY': D360_API_KEY, 'Content-Type': 'application/json' } });
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ===== Streamlit -> Chatwoot (reflejo) =====
/** Espera: { phone, name, content, client_message_id } */
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content, client_message_id } = req.body || {};
    if (!phone || !content) return res.status(400).json({ ok: false, error: 'phone y content son requeridos' });

    const normalizedPhone = normalizarNumero(String(phone).trim());
    if (client_message_id && processedClientMsgIds.has(client_message_id)) {
      return res.json({ ok: true, dedup: true });
    }

    const contact = await findOrCreateContact(normalizedPhone, name || 'Cliente WhatsApp');
    if (!contact?.id) return res.status(500).json({ ok: false, error: 'No se pudo crear/recuperar contacto' });

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) return res.status(500).json({ ok: false, error: 'No se pudo obtener source_id' });

    let conversationId = await getOrCreateConversation(contact.id, sourceId);
    if (!conversationId) return res.status(500).json({ ok: false, error: 'No se pudo crear conversación' });

    await waitForConversationReady(conversationId, 3, 300);

    const sent = await sendToChatwoot(conversationId, 'text', `${content}[streamlit]`, true, 4);
    if (!sent.ok) return res.status(502).json({ ok: false, error: 'No se pudo guardar mensaje en Chatwoot' });

    try {
      await axios.put(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, { status: 'open' }, { headers: cwHeaders });
      await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`, { assignee_id: null }, { headers: cwHeaders });
    } catch (e) { console.warn('⚠️ No se pudo forzar visibilidad:', e.message); }

    if (client_message_id) processedClientMsgIds.add(client_message_id);
    return res.json({ ok: true, messageId: sent.messageId, conversationId });

  } catch (err) {
    console.error('❌ Error en /send-chatwoot-message:', err.message);
    res.status(500).json({ ok: false, error: 'Error interno al reflejar' });
  }
});

app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
