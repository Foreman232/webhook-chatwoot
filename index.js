// index.js — 360dialog <-> Chatwoot con media (imagen/documento/audio/video/sticker), contactos y "Abierto" 
// Descarga binaria directa desde 360dialog probando múltiples endpoints y phone_number_id.

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json());

// ========= CONFIG =========
const CHATWOOT_API_TOKEN = '5ZSLaX4VCt4T2Z1aHRyPmTFb';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv904439.hstgr.cloud/api/v1/accounts';

const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = '7Ll0YquMGVElHWxofGvhi5oFAK';

const N8N_WEBHOOK_URL = 'https://n8n.srv876216.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

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
    payload.attachments = [{ file_type: type, file_url: content }]; // no usado en binarios
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

// ====== MEDIA (360dialog) — descarga binaria directa probando hosts/rutas con/sin phone_number_id ======
async function fetch360MediaBinary(mediaId, phoneNumberId) {
  // combinaciones de base y query
  const bases = [
    'https://waba-v2.360dialog.io/v1/media',
    'https://waba-v2.360dialog.io/media',
    'https://waba.360dialog.io/v1/media',
    'https://waba.360dialog.io/media'
  ];
  const queries = phoneNumberId ? ['', `?phone_number_id=${encodeURIComponent(phoneNumberId)}`] : [''];

  let lastErr = '', lastStatus = 0, lastUrl = '';
  for (const base of bases) {
    for (const q of queries) {
      const url = `$
