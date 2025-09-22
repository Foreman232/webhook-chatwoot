// index.js — 360dialog <-> Chatwoot con media (imagen/documento/audio/video/sticker), contactos y "Abierto"
// Versión mejorada con mejor manejo de descarga de medios

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

const D360_API_KEY        = '7Ll0YquMGVElHWxofGvhi5oFAK';
const D360_MEDIA_URL      = 'https://waba-v2.360dialog.io/v1/media'; // URL principal para media

const N8N_WEBHOOK_URL     = 'https://n8n.srv876216.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

const processedMessages = new Set(); // idempotencia simple

// ========= HELPERS =========
function normalizarNumero(numero) {
  if (!numero || typeof numero !== 'string') return '';
  if (numero.startsWith('+52') && !numero.startsWith('+521')) return '+521' + numero.slice(3);
  return numero;
}

function j(v){ 
  try{ 
    return typeof v==='string'?v:JSON.stringify(v, null, 2);
  }catch(_){ 
    return String(v);
  } 
}

// Función mejorada para obtener información del media desde 360dialog
async function getMediaInfo(mediaId, phoneNumberId) {
  console.log(`🔍 Obteniendo info de media ID: ${mediaId}, phone_number_id: ${phoneNumberId}`);
  
  const config = {
    headers: {
      'D360-API-KEY': D360_API_KEY,
      'Content-Type': 'application/json'
    }
  };

  // Intentar diferentes URLs para obtener la información del media
  const urls = [
    `${D360_MEDIA_URL}/${mediaId}`,
    `https://waba-v2.360dialog.io/v1/media/${mediaId}`,
    `https://waba.360dialog.io/v1/media/${mediaId}`
  ];

  if (phoneNumberId) {
    urls.push(`${D360_MEDIA_URL}/${mediaId}?phone_number_id=${phoneNumberId}`);
  }

  for (const url of urls) {
    try {
      console.log(`🌐 Intentando obtener info desde: ${url}`);
      const response = await axios.get(url, config);
      
      if (response.data && response.data.url) {
        console.log(`✅ Info de media obtenida desde: ${url}`);
        console.log(`📄 Respuesta:`, j(response.data));
        return response.data;
      }
    } catch (error) {
      console.warn(`⚠️ Error obteniendo info desde ${url}:`, error.response?.status, error.response?.data || error.message);
    }
  }

  throw new Error(`No se pudo obtener información del media ${mediaId}`);
}

// Función mejorada para descargar el archivo binario
async function downloadMediaBinary(mediaUrl, mediaId) {
  console.log(`⬇️ Descargando media desde URL: ${mediaUrl}`);
  
  const configs = [
    // Sin headers (URL firmada)
    {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024, // 50MB max
    },
    // Con API key
    {
      headers: {
        'D360-API-KEY': D360_API_KEY,
        'User-Agent': 'Mozilla/5.0 (compatible; 360dialog-webhook)',
      },
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
    }
  ];

  for (let i = 0; i < configs.length; i++) {
    try {
      console.log(`🔄 Intento ${i + 1} de descarga...`);
      const response = await axios.get(mediaUrl, configs[i]);
      
      if (response.data && response.data.byteLength > 0) {
        console.log(`✅ Media descargado exitosamente (${response.data.byteLength} bytes)`);
        return {
          buffer: Buffer.from(response.data),
          contentType: response.headers['content-type'] || 'application/octet-stream',
          size: response.data.byteLength
        };
      }
    } catch (error) {
      console.warn(`⚠️ Intento ${i + 1} falló:`, error.response?.status, error.message);
      if (i === configs.length - 1) {
        throw error;
      }
    }
  }
}

// Función combinada para obtener y descargar media
async function fetch360MediaBinary(mediaId, phoneNumberId) {
  try {
    // Paso 1: Obtener información del media (incluyendo URL de descarga)
    const mediaInfo = await getMediaInfo(mediaId, phoneNumberId);
    
    if (!mediaInfo.url) {
      throw new Error('No se encontró URL de descarga en la respuesta de 360dialog');
    }

    // Paso 2: Descargar el archivo binario
    const downloadResult = await downloadMediaBinary(mediaInfo.url, mediaId);
    
    return {
      buffer: downloadResult.buffer,
      mime: downloadResult.contentType,
      size: downloadResult.size,
      mediaInfo: mediaInfo
    };

  } catch (error) {
    console.error(`❌ Error completo en fetch360MediaBinary:`, error.message);
    throw error;
  }
}

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
  console.log(`📎 Subiendo adjunto a Chatwoot: ${filename} (${mime}, ${buffer.length} bytes)`);
  
  const form = new FormData();
  form.append('message_type', outgoing ? 'outgoing' : 'incoming');
  form.append('private', 'false');
  form.append('attachments[]', buffer, { filename, contentType: mime });

  const headers = { ...form.getHeaders(), 'api_access_token': CHATWOOT_API_TOKEN };
  
  try {
    const { data } = await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      form,
      { 
        headers,
        maxContentLength: 50 * 1024 * 1024, // 50MB max
        timeout: 30000
      }
    );
    console.log(`✅ Adjunto subido exitosamente a Chatwoot`);
    return data.id;
  } catch (error) {
    console.error(`❌ Error subiendo adjunto a Chatwoot:`, error.response?.data || error.message);
    throw error;
  }
}

// Forzar ABIERTO y (opcional) asignar
async function setConversationOpen(conversationId, assigneeId = null) {
  try {
    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
      { status: 'open' },
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`,
      { assignee_id: assigneeId }, // null => No asignados
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
  } catch (error) {
    console.warn('⚠️ Error configurando conversación como abierta:', error.message);
  }
}

// Nombre de archivo según tipo/mime
function filenameFor(type, mediaId, mime, mediaObj) {
  if (mediaObj?.filename) return mediaObj.filename;
  
  const extFromMime = (mime || '').split('/')[1]?.split(';')[0] || '';
  const byType = { 
    image: 'jpg', 
    video: 'mp4', 
    audio: 'ogg', 
    document: 'pdf', 
    sticker: 'webp' 
  };
  
  const extension = byType[type] || extFromMime || 'bin';
  return `wa-${type}-${mediaId}.${extension}`;
}

// ========= ENDPOINTS =========

// 1) Entrantes
app.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Webhook recibido:', j(req.body));
    
    const entry    = req.body.entry?.[0];
    const changes  = entry?.changes?.[0]?.value;
    const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
    const phone    = normalizarNumero(rawPhone);
    const name     = changes?.contacts?.[0]?.profile?.name;
    const msg      = changes?.messages?.[0];

    if (!phone || !msg || msg.from_me) {
      console.log('⚠️ Mensaje ignorado: sin teléfono, mensaje o es enviado por nosotros');
      return res.sendStatus(200);
    }

    const inboundId = msg.id;
    if (processedMessages.has(inboundId)) {
      console.log('⚠️ Mensaje ya procesado:', inboundId);
      return res.sendStatus(200);
    }
    processedMessages.add(inboundId);

    console.log(`📱 Procesando mensaje de ${phone} (${name}), tipo: ${msg.type}`);

    const contact = await findOrCreateContact(phone, name);
    if (!contact?.id) {
      console.error('❌ No se pudo crear/obtener contacto');
      return res.sendStatus(500);
    }

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) {
      console.error('❌ No se pudo obtener source_id');
      return res.sendStatus(500);
    }

    const conversationId = await getOrCreateConversation(contact.id, sourceId);
    if (!conversationId) {
      console.error('❌ No se pudo crear conversación');
      return res.sendStatus(500);
    }

    // phone_number_id (cuando viene en el payload)
    const phoneNumberId =
      changes?.metadata?.phone_number_id ||
      changes?.metadata?.phone_number?.id ||
      changes?.phone_number_id || 
      entry?.id || // A veces viene en entry.id
      '';

    console.log(`🔑 Phone Number ID extraído: ${phoneNumberId}`);

    const type = msg.type;

    if (type === 'text') {
      console.log(`💬 Procesando mensaje de texto: ${msg.text.body}`);
      await sendToChatwoot(conversationId, 'text', msg.text.body, false);

    } else if (['image', 'document', 'audio', 'video', 'sticker'].includes(type)) {
      const mediaObj = msg[type] || {};
      const mediaId  = mediaObj.id;
      const caption  = mediaObj.caption || '';

      console.log(`🎭 Procesando media tipo: ${type}, ID: ${mediaId}`);
      console.log(`📄 Objeto media completo:`, j(mediaObj));

      if (!mediaId) {
        console.error('❌ No se encontró media ID en el mensaje');
        await sendToChatwoot(conversationId, 'text', '[Media recibido pero sin ID válido]', false);
      } else {
        try {
          const mediaResult = await fetch360MediaBinary(mediaId, phoneNumberId);
          const filename = filenameFor(type, mediaId, mediaResult.mime, mediaObj);
          
          console.log(`📁 Preparando archivo: ${filename} (${mediaResult.mime}, ${mediaResult.size} bytes)`);
          
          await sendAttachmentToChatwoot(conversationId, mediaResult.buffer, filename, mediaResult.mime, false);
          
          if (caption) {
            console.log(`💬 Enviando caption: ${caption}`);
            await sendToChatwoot(conversationId, 'text', caption, false);
          }
          
          console.log(`✅ Media procesado exitosamente: ${type}`);
          
        } catch (error) {
          console.error(`❌ Error procesando media (id=${mediaId}, pnid=${phoneNumberId}):`, error.message);
          console.error(`📄 Stack trace:`, error.stack);
          console.error(`📄 Media object:`, j(mediaObj));
          
          // Enviar mensaje de error más descriptivo
          const errorMsg = `[❌ Media ${type} recibido pero no se pudo procesar: ${error.message}]`;
          await sendToChatwoot(conversationId, 'text', errorMsg, false);
        }
      }

    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      console.log(`📍 Procesando ubicación: ${locStr}`);
      await sendToChatwoot(conversationId, 'text', locStr, false);

    } else if (type === 'contacts') {
      const c = (msg.contacts && msg.contacts[0]) || {};
      const nm = c.name || {};
      const fullName = nm.formatted_name || [nm.first_name, nm.middle_name, nm.last_name].filter(Boolean).join(' ');
      const phones = (c.phones || []).map(p => `📞 ${p.wa_id || p.phone}${p.type ? ' (' + p.type + ')' : ''}`);
      const emails = (c.emails || []).map(e => `✉️ ${e.email}`);
      const org    = c.org?.company ? `🏢 ${c.org.company}` : '';
      const lines  = [fullName || 'Contacto', org, ...phones, ...emails].filter(Boolean);
      console.log(`👤 Procesando contacto: ${fullName}`);
      await sendToChatwoot(conversationId, 'text', lines.join('\n'), false);

    } else {
      console.log(`❓ Tipo de mensaje no soportado: ${type}`);
      await sendToChatwoot(conversationId, 'text', `[Contenido tipo "${type}" no soportado]`, false);
    }

    // Establecer conversación como abierta
    await setConversationOpen(conversationId, null);

    // Enviar a n8n (opcional)
    try {
      const content = type === 'text' ? msg.text.body : `[${type}]`;
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content }, {
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 5000
      });
    } catch (n8nErr) {
      console.error('❌ Error enviando a n8n:', n8nErr.message);
    }

    console.log('✅ Webhook procesado exitosamente');
    res.sendStatus(200);
    
  } catch (err) {
    console.error('❌ Error general en webhook:', err.message);
    console.error('📄 Stack trace:', err.stack);
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
    await axios.post('https://waba-v2.360dialog.io/messages', {
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

    await setConversationOpen(conversationId, null);

    return res.status(200).json({ ok: true, messageId, conversationId });
  } catch (err) {
    console.error('❌ Error en /send-chatwoot-message:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

// Endpoint de prueba para debug
app.get('/test-media/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    const phoneNumberId = req.query.phone_number_id || '';
    
    console.log(`🧪 Test de descarga de media: ${mediaId}, phone_number_id: ${phoneNumberId}`);
    
    const result = await fetch360MediaBinary(mediaId, phoneNumberId);
    
    res.json({
      success: true,
      mediaId,
      phoneNumberId,
      size: result.size,
      mime: result.mime,
      mediaInfo: result.mediaInfo
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      mediaId: req.params.mediaId
    });
  }
});

// ========= SERVER =========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
