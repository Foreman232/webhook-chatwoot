// index.js — 360dialog <-> Chatwoot con media (imagen/documento/audio/video/sticker), contactos y "Abierto"
// Descarga binaria con signed URL de 360dialog.

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json());

// ========= CONFIG =========
const CHATWOOT_API_TOKEN  = '5ZSLaX4VCt4T2Z1aHRyPmTFb';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID   = '1';
const BASE_URL            = 'https://srv904439.hstgr.cloud/api/v1/accounts';

const D360_API_URL        = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY        = '7Ll0YquMGVElHWxofGvhi5oFAK';

const N8N_WEBHOOK_URL     = 'https://n8n.srv876216.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

const processedMessages = new Set(); // idempotencia simple

// ========= HELPERS =========
function normalizarNumero(numero) {
  if (!numero || typeof numero !== 'string') return '';
  if (numero.startsWith('+52') && !numero.startsWith('+521')) return '+521' + numero.slice(3);
  return numero;
}
function j(v){ try{ return typeof v==='string'?v:JSON.stringify(v);}catch(_){ return String(v);} }

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = normalizarNumero(phone);
  const payload = { inbox_id: CHATWOOT_INBOX_ID, name, identifier, phone_number: identifier };
  try {
    const { data } = await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`,
      payload,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    return data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const { data } = await axios.get(
        `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(identifier)}`,
        { headers: { api_access_token: CHATWOOT_API_TOKEN } }
      );
      return data.payload?.[0];
    }
    console.error('❌ Contacto error:', j(err.response?.data) || err.message);
    return null;
  }
}

async function getSourceId(contactId) {
  try {
    const { data } = await axios.get(
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
    const { data } = await axios.get(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    if (Array.isArray(data.payload) && data.payload.length > 0) return data.payload[0].id;

    const resp = await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`,
      { source_id: sourceId, inbox_id: CHATWOOT_INBOX_ID },
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    return resp.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', j(err.response?.data) || err.message);
    return null;
  }
}

// Reintentos al guardar texto
async function sendToChatwoot(conversationId, type, content, outgoing = false, maxRetries = 4) {
  const payload = { message_type: outgoing ? 'outgoing' : 'incoming', private: false };
  if (['image', 'document', 'audio', 'video'].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else {
    payload.content = content;
  }
  let wait = 350, lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const { data } = await axios.post(
        `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
        payload,
        { headers: { api_access_token: CHATWOOT_API_TOKEN } }
      );
      return data.id;
    } catch (err) {
      const s = err.response?.status;
      const retriable = s === 404 || s === 422 || s === 409;
      lastErr = j(err.response?.data) || err.message;
      if (!retriable) throw err;
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 2000);
    }
  }
  throw new Error(`sendToChatwoot failed: ${lastErr}`);
}

// Subir adjunto binario a Chatwoot
async function sendAttachmentToChatwoot(conversationId, buffer, filename, mime, outgoing = false) {
  const form = new FormData();
  form.append('message_type', outgoing ? 'outgoing' : 'incoming');
  form.append('private', 'false');
  form.append('attachments[]', buffer, { filename, contentType: mime });

  const headers = { ...form.getHeaders(), 'api_access_token': CHATWOOT_API_TOKEN };
  const { data } = await axios.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    form,
    { headers }
  );
  return data.id;
}

// ====== MEDIA (360dialog) — pedir signed URL y bajar binario ======
async function fetch360MediaBinary(mediaId) {
  try {
    // 1) pedir signed URL con API key
    const resp = await axios.get(
      `https://waba-v2.360dialog.io/v1/media/${mediaId}`,
      { headers: { 'D360-API-KEY': D360_API_KEY } }
    );

    if (!resp.data?.url) {
      throw new Error(`No signed URL in response: ${JSON.stringify(resp.data)}`);
    }

    const signedUrl = resp.data.url;

    // 2) bajar binario desde la signed URL
    const fileResp = await axios.get(signedUrl, { responseType: 'arraybuffer' });

    return {
      buffer: Buffer.from(fileResp.data),
      mime: fileResp.headers['content-type'] || 'application/octet-stream',
      urlTried: signedUrl
    };
  } catch (err) {
    throw new Error(`fetch360MediaBinary failed (id=${mediaId}): ${j(err.response?.data) || err.message}`);
  }
}

// Forzar ABIERTO y (opcional) asignar
async function setConversationOpen(conversationId, assigneeId = null) {
  await axios.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
    { status: 'open' },
    { headers: { api_access_token: CHATWOOT_API_TOKEN } }
  );
  await axios.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`,
    { assignee_id: assigneeId },
    { headers: { api_access_token: CHATWOOT_API_TOKEN } }
  );
}

// Nombre de archivo según tipo/mime
function filenameFor(type, mediaId, mime, mediaObj) {
  if (mediaObj?.filename) return mediaObj.filename;
  const extFromMime = (mime || '').split('/')[1]?.split(';')[0] || '';
  const byType = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'pdf', sticker: 'webp' };
  const def = byType[type] || extFromMime || 'bin';
  return `wa-${type}-${mediaId}.${def}`;
}

// ========= ENDPOINTS =========

// 1) Entrantes
app.post('/webhook', async (req, res) => {
  try {
    const entry    = req.body.entry?.[0];
    const changes  = entry?.changes?.[0]?.value;
    const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
    const phone    = normalizarNumero(rawPhone);
    const name     = changes?.contacts?.[0]?.profile?.name;
    const msg      = changes?.messages?.[0];

    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const inboundId = msg.id;
    if (processedMessages.has(inboundId)) return res.sendStatus(200);
    processedMessages.add(inboundId);

    const contact = await findOrCreateContact(phone, name);
    if (!contact?.id) return res.sendStatus(500);

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) return res.sendStatus(500);

    const conversationId = await getOrCreateConversation(contact.id, sourceId);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body, false);

    } else if (['image', 'document', 'audio', 'video', 'sticker'].includes(type)) {
      const mediaObj = msg[type] || {};
      const mediaId  = mediaObj.id;
      const caption  = mediaObj.caption || '';

      try {
        const { buffer, mime, urlTried } = await fetch360MediaBinary(mediaId);
        const fname = filenameFor(type, mediaId, mime, mediaObj);
        console.log(`✅ media descargado de ${urlTried} (${mime}; ${buffer.length} bytes)`);
        await sendAttachmentToChatwoot(conversationId, buffer, fname, mime, false);
        if (caption) await sendToChatwoot(conversationId, 'text', caption, false);
      } catch (e) {
        console.error(`❌ No se pudo descargar/subir media (id=${mediaId}):`, e.message, 'mediaObj=', j(mediaObj));
        await sendToChatwoot(conversationId, 'text', '[Media recibido pero no se pudo descargar]', false);
      }

    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr, false);

    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]', false);
    }

    try { await setConversationOpen(conversationId, null); }
    catch (e) { console.warn('⚠️ No se pudo abrir (webhook):', e.message); }

    // n8n (opcional)
    try {
      const content = type === 'text' ? msg.text.body : `[${type}]`;
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content }, {
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });
    } catch (n8nErr) {
      console.error('❌ Error enviando a n8n:', n8nErr.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// 2) Salientes desde Chatwoot -> WhatsApp (texto)
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
    return res.sendStatus(200);
  }
  const cwMsgId   = msg.id;
  const rawNumber = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const number    = normalizarNumero(`+${rawNumber}`).replace('+', '');
  const content   = msg.content;

  if (processedMessages.has(cwMsgId)) return res.sendStatus(200);
  processedMessages.add(cwMsgId);

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
    console.error('❌ Error enviando a WhatsApp:', j(err.response?.data) || err.message);
    res.sendStatus(500);
  }
});

// 3) Reflejo desde Streamlit -> Chatwoot (y Abrir)
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    const normalizedPhone = normalizarNumero(String(phone || '').trim());

    console.log('📥 Reflejando mensaje desde Streamlit:', { phone: normalizedPhone, name, content });

    const contact = await findOrCreateContact(normalizedPhone, name || 'Cliente WhatsApp');
    if (!contact?.id) return res.status(500).send('No se pudo crear/recuperar contacto');

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) return res.status(500).send('No se pudo obtener source_id');

    let conversationId = null;
    for (let i = 0; i < 5; i++) {
      conversationId = await getOrCreateConversation(contact.id, sourceId);
      if (conversationId) {
        try {
          const check = await axios.get(
            `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`,
            { headers: { api_access_token: CHATWOOT_API_TOKEN } }
          );
          if (check.status === 200) break;
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 600));
    }
    if (!conversationId) return res.status(500).send('No se pudo crear conversación');

    const messageId = await sendToChatwoot(conversationId, 'text', `${content}[streamlit]`, true);

    try { await setConversationOpen(conversationId, null); }
    catch (e) { console.warn('⚠️ No se pudo abrir (reflejo):', e.message); }

    return res.status(200).json({ ok: true, messageId, conversationId });
  } catch (err) {
    console.error('❌ Error en /send-chatwoot-message:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

// ========= SERVER =========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));

