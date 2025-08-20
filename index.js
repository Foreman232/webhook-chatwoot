// index.js – versión robusta con idempotencia + reintentos + ACK duro

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const app = express();
app.use(bodyParser.json());

// ================== CONFIG ==================
const CHATWOOT_API_TOKEN   = '5ZSLaX4VCt4T2Z1aHRyPmTFb';
const CHATWOOT_ACCOUNT_ID  = '1';
const CHATWOOT_INBOX_ID    = '1';
const BASE_URL             = 'https://srv904439.hstgr.cloud/api/v1/accounts';
const D360_API_URL         = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY         = '7Ll0YquMGVElHWxofGvhi5oFAK';
const N8N_WEBHOOK_URL      = 'https://n8n.srv876216.hstgr.cloud/webhook-test/confirmar-tarimas';

// ============ UTIL: Normalización y caches ============
function normalizarNumero(numero) {
  if (!numero || typeof numero !== 'string') return '';
  if (numero.startsWith('+52') && !numero.startsWith('+521')) return '+521' + numero.slice(3);
  return numero;
}

// Cache simple con expiración (para no crecer ilimitado)
function makeExpiringSet(ms = 15 * 60 * 1000) {
  const map = new Map(); // key -> expiresAt
  const has = (k) => {
    const t = map.get(k);
    if (!t) return false;
    if (Date.now() > t) { map.delete(k); return false; }
    return true;
  };
  const add = (k) => map.set(k, Date.now() + ms);
  const size = () => map.size;
  const prune = () => {
    const now = Date.now();
    for (const [k, t] of map.entries()) if (t <= now) map.delete(k);
  };
  return { has, add, size, prune };
}

const processedInboundIds   = makeExpiringSet(); // msg.id entrantes
const processedOutboundIds  = makeExpiringSet(); // msg.id salientes Chatwoot
const processedClientMsgIds = makeExpiringSet(); // client_message_id desde Streamlit

// ================== Chatwoot helpers ==================
const cwHeaders = { api_access_token: CHATWOOT_API_TOKEN };

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = normalizarNumero(phone);
  const payload = { inbox_id: CHATWOOT_INBOX_ID, name, identifier, phone_number: identifier };
  try {
    const { data } = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, { headers: cwHeaders });
    return data.payload;
  } catch (err) {
    // Si ya existe, buscarlo
    if (err.response?.data?.message?.includes('has already been taken')) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(identifier)}`, { headers: cwHeaders });
      return getResp.data.payload?.[0];
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
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, { headers: cwHeaders });
    // Reutiliza la 1ra conversación si existe (ideal: reabrir si estaba resuelta, CW lo abre al enviar msg)
    if (Array.isArray(convRes.data.payload) && convRes.data.payload.length > 0) {
      return convRes.data.payload[0].id;
    }
    const { data } = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      inbox_id: CHATWOOT_INBOX_ID,
    }, { headers: cwHeaders });
    return data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.response?.data || err.message);
    return null;
  }
}

// Poll corto para asegurar que la conversación ya “apareció” del lado CW antes del primer mensaje
async function waitForConversationReady(conversationId, attempts = 3, delayMs = 350) {
  for (let i = 0; i < attempts; i++) {
    try {
      const check = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, { headers: cwHeaders });
      if (check.status === 200) return true;
    } catch (_) { /* noop */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// Envía mensaje saliente con reintentos si CW aún no registra conversa (404/422)
async function sendToChatwoot(conversationId, type, content, outgoing = false, maxRetries = 3) {
  const payload = { message_type: outgoing ? 'outgoing' : 'incoming', private: false };

  if (['image', 'document', 'audio', 'video'].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else {
    payload.content = content;
  }

  let wait = 400;
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { data } = await axios.post(
        `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        payload,
        { headers: cwHeaders }
      );
      // data.id es el ID del mensaje en Chatwoot
      return { ok: true, messageId: data.id };
    } catch (err) {
      const status = err.response?.status;
      const retriable = status === 404 || status === 422 || status === 409;
      lastErr = err.response?.data || err.message;
      if (!retriable) break;
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 2000);
    }
  }
  return { ok: false, error: lastErr };
}

// ================== Webhook entrante (360dialog -> Chatwoot) ==================
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
      const loc = msg.location;
      const locStr = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr, false);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]', false);
    }

    // Reenvío a n8n (ignorar TLS estricto si hay cert autofirmado)
    try {
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content }, { httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
    } catch (n8nErr) {
      console.error('❌ Error enviando a n8n:', n8nErr.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ================== Outbound (Chatwoot -> 360dialog) ==================
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  // Evitar loop y filtrar solo mensajes OUTGOING “normales”
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
    console.log(`📤 Enviando a WhatsApp: ${number} | ${content}`);
    await axios.post(D360_API_URL, {
      messaging_product: 'whatsapp',
      to: number,
      type: 'text',
      text: { body: content }
    }, {
      headers: { 'D360-API-KEY': D360_API_KEY, 'Content-Type': 'application/json' }
    });
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ================== Reflejo desde Streamlit -> Chatwoot ==================
/**
 * Espera JSON:
 * {
 *   phone: "+52.../ +502...",
 *   name: "Nombre",
 *   content: "Texto humano a reflejar",
 *   client_message_id: "sha1|uuid"   <-- idempotencia
 * }
 */
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content, client_message_id } = req.body || {};
    if (!phone || !content) return res.status(400).json({ ok: false, error: 'phone y content son requeridos' });

    const normalizedPhone = normalizarNumero(String(phone).trim());

    // Idempotencia: si ya lo procesamos, responde OK con eco (no reenviar)
    if (client_message_id && processedClientMsgIds.has(client_message_id)) {
      return res.json({ ok: true, dedup: true });
    }

    console.log('📥 Reflejando desde Streamlit:', { phone: normalizedPhone, name, len: content?.length });

    const contact = await findOrCreateContact(normalizedPhone, name || 'Cliente WhatsApp');
    if (!contact?.id) {
      console.error('❌ Contacto inválido o no creado:', contact);
      return res.status(500).json({ ok: false, error: 'No se pudo crear/recuperar contacto' });
    }

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) {
      console.error('❌ No se encontró source_id');
      return res.status(500).json({ ok: false, error: 'No se pudo obtener source_id' });
    }

    let conversationId = await getOrCreateConversation(contact.id, sourceId);
    if (!conversationId) return res.status(500).json({ ok: false, error: 'No se pudo crear conversación' });

    // Pequeño poll para asegurar que la conversación está lista
    await waitForConversationReady(conversationId, 3, 300);

    // Enviar mensaje SALIENTE, marcando para no causar bucle en /outbound
    const toSend = `${content}[streamlit]`;
    const sent = await sendToChatwoot(conversationId, 'text', toSend, true, 4);

    if (!sent.ok) {
      console.error('❌ Falló sendToChatwoot:', sent.error);
      return res.status(502).json({ ok: false, error: 'No se pudo guardar mensaje en Chatwoot' });
    }

    // Opcional: asegurar visibilidad en inbox
    try {
      await axios.put(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, { status: 'open' }, { headers: cwHeaders });
      await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`, { assignee_id: null }, { headers: cwHeaders });
    } catch (e) {
      console.warn('⚠️ No se pudo forzar visibilidad/assign:', e.message);
    }

    if (client_message_id) processedClientMsgIds.add(client_message_id);

    return res.json({ ok: true, messageId: sent.messageId, conversationId });

  } catch (err) {
    console.error('❌ Error general en /send-chatwoot-message:', err.message);
    res.status(500).json({ ok: false, error: 'Error interno al reflejar' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
