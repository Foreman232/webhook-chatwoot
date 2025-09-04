// index.js — 360dialog <-> Chatwoot con media, contactos y "Abierto"
// Versión optimizada: respuesta inmediata al webhook, n8n no bloqueante, timeouts y keep-alive.

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');

// CORS (fallback si no está instalado)
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

// ========= AXIOS (keep-alive + timeouts) =========
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const AX = axios.create({
  timeout: 6000,
  httpAgent,
  httpsAgent,
  validateStatus: s => s >= 200 && s < 500 // manejamos 4xx en código
});

const AX_INSECURE = axios.create({
  timeout: 4000,
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

// ========== Anti-duplicados (con limpieza simple) ==========
const processedMessages = new Map(); // id -> timestamp
function seen(id) {
  const now = Date.now();
  // cleanup cada 1000 inserciones aprox
  if (processedMessages.size > 2000) {
    for (const [k, ts] of processedMessages) {
      if (now - ts > 1000 * 60 * 30) processedMessages.delete(k); // 30 min
    }
  }
  if (processedMessages.has(id)) return true;
  processedMessages.set(id, now);
  return false;
}

// ====== Chatwoot helpers ======
async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = normalizarNumero(phone);
  const payload = { inbox_id: CHATWOOT_INBOX_ID, name, identifier, phone_number: identifier };
  try {
    const { data, status } = await AX.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`,
      payload,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    if (status >= 200 && status < 300) return data.payload;
    // si cae aquí, probamos búsqueda
  } catch (err) {
    // sigue abajo
  }
  try {
    const { data } = await AX.get(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(identifier)}`,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    return data.payload?.[0] || null;
  } catch (err) {
    console.error('❌ Contacto error:', j(err.response?.data) || err.message);
    return null;
  }
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
    const { data } = await AX.get(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    if (Array.isArray(data.payload) && data.payload.length > 0) return data.payload[0].id;
  } catch (_) {}
  try {
    const resp = await AX.post(
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
  let wait = 300, lastErr;
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
      await new Promise(r => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 1800);
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
  const { data, status } = await AX.post(
    `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
    form,
    { headers, maxBodyLength: Infinity, maxContentLength: Infinity }
  );
  if (status >= 200 && status < 300) return data.id;
  throw new Error(`Adjunto CW ${status}: ${j(data)}`);
}

// ====== MEDIA (360dialog) ======
async function fetch360MediaBinary(mediaId, phoneNumberId) {
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
      const url = `${base}/${mediaId}${q}`;
      try {
        // 1) sin header
        let resp = await AX.get(url, { responseType: 'arraybuffer', validateStatus: s => s >= 200 && s < 400 });
        if (resp.status === 200) {
          return {
            buffer: Buffer.from(resp.data),
            mime: resp.headers['content-type'] || 'application/octet-stream',
            urlTried: url
          };
        }
      } catch (e1) {
        // 2) con API KEY
        try {
          const resp2 = await AX.get(url, {
            headers: { 'D360-API-KEY': D360_API_KEY, 'Accept': '*/*' },
            responseType: 'arraybuffer',
            validateStatus: s => s >= 200 && s < 400
          });
          if (resp2.status === 200) {
            return {
              buffer: Buffer.from(resp2.data),
              mime: resp2.headers['content-type'] || 'application/octet-stream',
              urlTried: url
            };
          }
          lastStatus = resp2.status;
          lastErr = j(resp2.data);
          lastUrl = url;
          console.warn(`⚠️ media GET (c/key) falló @ ${url} => ${lastStatus} ${lastErr}`);
        } catch (e2) {
          lastStatus = e2.response?.status || 0;
          lastErr    = j(e2.response?.data) || e2.message;
          lastUrl    = url;
          console.warn(`⚠️ media GET falló @ ${url} => ${lastStatus} ${lastErr}`);
        }
      }
    }
  }
  throw new Error(`No media from 360dialog (id=${mediaId}, pnid=${phoneNumberId}). Último: ${lastStatus} @ ${lastUrl} :: ${lastErr}`);
}

// Forzar ABIERTO y (opcional) asignar
async function setConversationOpen(conversationId, assigneeId = null) {
  const headers = { api_access_token: CHATWOOT_API_TOKEN };
  await Promise.allSettled([
    AX.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`, { status: 'open' }, { headers }),
    assigneeId !== null
      ? AX.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`, { assignee_id: assigneeId }, { headers })
      : Promise.resolve()
  ]);
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
app.get('/health', (_req, res) => res.status(200).send('ok'));

// 1) Entrantes (360dialog -> Chatwoot)
app.post('/webhook', (req, res) => {
  // Respuesta inmediata para no bloquear a 360dialog
  res.sendStatus(200);

  // Procesamiento asíncrono no-bloqueante
  setImmediate(async () => {
    try {
      const entry    = req.body.entry?.[0];
      const changes  = entry?.changes?.[0]?.value;
      const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
      const phone    = normalizarNumero(rawPhone);
      const name     = changes?.contacts?.[0]?.profile?.name;
      const msg      = changes?.messages?.[0];

      if (!phone || !msg || msg.from_me) return;

      const inboundId = msg.id;
      if (seen(inboundId)) return;

      const contact = await findOrCreateContact(phone, name);
      if (!contact?.id) return;

      const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
      if (!sourceId) return;

      const conversationId = await getOrCreateConversation(contact.id, sourceId);
      if (!conversationId) return;

      const phoneNumberId =
        changes?.metadata?.phone_number_id ||
        changes?.metadata?.phone_number?.id ||
        changes?.phone_number_id ||
        '';

      const type = msg.type;

      if (type === 'text') {
        await sendToChatwoot(conversationId, 'text', msg.text.body, false);

      } else if (['image', 'document', 'audio', 'video', 'sticker'].includes(type)) {
        const mediaObj = msg[type] || {};
        const mediaId  = mediaObj.id;
        const caption  = mediaObj.caption || '';

        try {
          const { buffer, mime, urlTried } = await fetch360MediaBinary(mediaId, phoneNumberId);
          const fname = filenameFor(type, mediaId, mime, mediaObj);
          console.log(`✅ media descargado de ${urlTried} (${mime}; ${buffer.length} bytes)`);
          await sendAttachmentToChatwoot(conversationId, buffer, fname, mime, false);
          if (caption) await sendToChatwoot(conversationId, 'text', caption, false);
        } catch (e) {
          console.error(`❌ No se pudo descargar/subir media (id=${mediaId}, pnid=${phoneNumberId}):`, e.message, 'mediaObj=', j(mediaObj));
          await sendToChatwoot(conversationId, 'text', '[Media recibido pero no se pudo descargar]', false);
        }

      } else if (type === 'location') {
        const loc = msg.location;
        const locStr = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
        await sendToChatwoot(conversationId, 'text', locStr, false);

      } else if (type === 'contacts') {
        const c = (msg.contacts && msg.contacts[0]) || {};
        const nm = c.name || {};
        const fullName = nm.formatted_name || [nm.first_name, nm.middle_name, nm.last_name].filter(Boolean).join(' ');
        const phones = (c.phones || []).map(p => `📞 ${p.wa_id || p.phone}${p.type ? ' (' + p.type + ')' : ''}`);
        const emails = (c.emails || []).map(e => `✉️ ${e.email}`);
        const org    = c.org?.company ? `🏢 ${c.org.company}` : '';
        const lines  = [fullName || 'Contacto', org, ...phones, ...emails].filter(Boolean);
        await sendToChatwoot(conversationId, 'text', lines.join('\n'), false);

      } else {
        await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]', false);
      }

      // Abrir y (opcional) asignar sin bloquear
      setConversationOpen(conversationId, null).catch(e => {
        console.warn('⚠️ No se pudo abrir (webhook):', e.message);
      });

      // n8n: fire-and-forget con timeout y sin bloquear
      (async () => {
        try {
          const content = type === 'text' ? msg.text.body : `[${type}]`;
          const r = await AX_INSECURE.post(N8N_WEBHOOK_URL, { phone, name, type, content });
          if (r.status >= 300) {
            console.warn('⚠️ n8n respondió no-2xx:', r.status, j(r.data));
          }
        } catch (n8nErr) {
          console.warn('⚠️ n8n no disponible:', n8nErr.message);
        }
      })();

    } catch (err) {
      console.error('❌ Webhook error (async):', err.message);
    }
  });
});

// 2) Salientes desde Chatwoot -> WhatsApp (texto)
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
          const check = await AX.get(
            `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`,
            { headers: { api_access_token: CHATWOOT_API_TOKEN } }
          );
          if (check.status === 200) break;
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!conversationId) return res.status(500).send('No se pudo crear conversación');

    const messageId = await sendToChatwoot(conversationId, 'text', `${content}[streamlit]`, true);

    setConversationOpen(conversationId, null).catch(e => {
      console.warn('⚠️ No se pudo abrir (reflejo):', e.message);
    });

    return res.status(200).json({ ok: true, messageId, conversationId });
  } catch (err) {
    console.error('❌ Error en /send-chatwoot-message:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
