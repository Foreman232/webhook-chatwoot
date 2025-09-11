// index.js — 360dialog <-> Chatwoot con media persistente, contactos y "Abierto"
// Ahora descarga el media inmediatamente y lo guarda en ./media para evitar expiración.

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

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

const MEDIA_DIR           = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

const processedMessages = new Set();

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

// ========= MENSAJES =========
async function sendToChatwoot(conversationId, type, content, outgoing = false) {
  const payload = { message_type: outgoing ? 'outgoing' : 'incoming', private: false };
  if (['image', 'document', 'audio', 'video'].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else {
    payload.content = content;
  }

  const { data } = await axios.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    payload,
    { headers: { api_access_token: CHATWOOT_API_TOKEN } }
  );
  return data.id;
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

// Mensajes de sistema
async function sendSystemNote(conversationId, content) {
  return await sendToChatwoot(conversationId, 'text', `⚠️ ${content}`, false);
}

// ========= MEDIA (360dialog) =========
async function fetch360MediaBinary(mediaId, type) {
  const resp = await axios.get(
    `https://waba-v2.360dialog.io/v1/media/${mediaId}`,
    { headers: { 'D360-API-KEY': D360_API_KEY } }
  );

  if (!resp.data?.url) {
    throw new Error(`No signed URL in response: ${JSON.stringify(resp.data)}`);
  }

  const signedUrl = resp.data.url;
  const fileResp = await axios.get(signedUrl, { responseType: 'arraybuffer' });

  const mime = fileResp.headers['content-type'] || 'application/octet-stream';
  const ext = mime.split('/')[1] || (type === 'audio' ? 'ogg' : 'bin');
  const filename = `wa-${type}-${mediaId}.${ext}`;
  const savePath = path.join(MEDIA_DIR, filename);

  fs.writeFileSync(savePath, fileResp.data);
  console.log(`📂 Media guardado en ${savePath}`);

  return { buffer: Buffer.from(fileResp.data), mime, localPath: savePath, filename };
}

// ========= CONVERSACIÓN =========
async function setConversationOpen(conversationId, assigneeId = null) {
  await axios.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
    { status: 'open' },
    { headers: { api_access_token: CHATWOOT_API_TOKEN } }
  );
}

// ========= ENDPOINTS =========
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
        const { buffer, mime, localPath, filename } = await fetch360MediaBinary(mediaId, type);
        const fileBuffer = fs.readFileSync(localPath);

        await sendAttachmentToChatwoot(conversationId, fileBuffer, filename, mime, false);
        if (caption) await sendToChatwoot(conversationId, 'text', caption, false);
      } catch (e) {
        console.error(`❌ No se pudo descargar media (id=${mediaId}):`, e.message);
        await sendSystemNote(conversationId, 'Media expirado o no encontrado (no se pudo descargar desde WhatsApp)');
      }

    } else {
      await sendSystemNote(conversationId, 'Contenido no soportado');
    }

    try { await setConversationOpen(conversationId, null); }
    catch (e) { console.warn('⚠️ No se pudo abrir conversación:', e.message); }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ========= SERVER =========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));


