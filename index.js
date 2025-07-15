// index.js COMPLETO CON FIX DE DUPLICADOS
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

const CHATWOOT_API_TOKEN = 'orUPYDWoDBkCShVrTSRUZsRx';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv904439.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';
const N8N_WEBHOOK_URL = 'https://n8n.srv869869.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

const processedMessages = new Set();

// Limpieza de cache cada hora
setInterval(() => {
  processedMessages.clear();
  console.log('🧹 Limpiado cache de mensajes procesados');
}, 60 * 60 * 1000);

// Normaliza a +521 para MX y +502 para GT
function normalizePhone(phone) {
  phone = phone.replace(/\D/g, '');
  if (phone.startsWith('521')) return '+521' + phone.slice(3);
  if (phone.startsWith('52')) return '+521' + phone.slice(2);
  if (phone.startsWith('502')) return '+502' + phone.slice(3);
  return '+' + phone;
}

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = normalizePhone(phone);
  const payload = {
    inbox_id: CHATWOOT_INBOX_ID,
    name,
    identifier,
    phone_number: identifier
  };
  try {
    const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return response.data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return getResp.data.payload[0];
    }
    console.error('❌ Contacto error:', err.message);
    return null;
  }
}

async function linkContactToInbox(contactId, phone) {
  const normalized = normalizePhone(phone);
  try {
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      inbox_id: CHATWOOT_INBOX_ID,
      source_id: normalized
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    if (!err.response?.data?.message?.includes('has already been taken')) {
      console.error('❌ Inbox link error:', err.message);
    }
  }
}

async function getContactInboxId(contactId, phone) {
  const normalized = normalizePhone(phone);
  try {
    const response = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    const inboxes = response.data.payload || [];
    const match = inboxes.find(i => i.source_id === normalized || i.source_id === normalized.replace('+521', '+52'));
    return match?.id || null;
  } catch (err) {
    console.error('❌ getContactInboxId error:', err.message);
    return null;
  }
}

async function getOrCreateConversation(contactId, phone) {
  try {
    const existing = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (existing.data.payload.length > 0) return existing.data.payload[0].id;

    const contact_inbox_id = await getContactInboxId(contactId, phone);
    if (!contact_inbox_id) throw new Error('No se encontró contact_inbox_id');

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      contact_inbox_id
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return newConv.data.id;
  } catch (err) {
    console.error('❌ Crear conversación error:', err.message);
    return null;
  }
}

async function sendToChatwoot(conversationId, type, content, outgoing = false) {
  const payload = {
    message_type: outgoing ? 'outgoing' : 'incoming',
    private: false
  };
  if (["image", "document", "audio", "video"].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else {
    payload.content = content;
  }
  await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
    headers: { api_access_token: CHATWOOT_API_TOKEN }
  });
}

// Webhook entrante de WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
    const phone = normalizePhone(rawPhone);
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const msgId = msg.id;
    if (processedMessages.has(msgId)) return res.sendStatus(200);
    processedMessages.add(msgId);

    const contact = await findOrCreateContact(phone, name);
    if (!contact) return res.sendStatus(500);

    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, phone);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;
    const content = msg[type]?.body || msg[type]?.caption || '[media]';

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);
    } else if (['image', 'document', 'audio', 'video'].includes(type)) {
      await sendToChatwoot(conversationId, type, content);
    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]');
    }

    await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content });
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// Mensajes salientes desde Chatwoot
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
    return res.sendStatus(200);
  }

  const messageId = msg.id;
  const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content = msg.content;

  if (processedMessages.has(messageId)) return res.sendStatus(200);
  processedMessages.add(messageId);

  if (!number || !content) return res.sendStatus(200);

  try {
    await axios.post(D360_API_URL, {
      messaging_product: 'whatsapp',
      to: number,
      type: 'text',
      text: { body: content }
    }, {
      headers: {
        'D360-API-KEY': D360_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Enviado a WhatsApp: ${content}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.message);
    res.sendStatus(500);
  }
});

// Mensajes masivos desde Streamlit
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    let { phone, name, content } = req.body;
    phone = normalizePhone(phone);
    if (!phone || !content) return res.status(400).send('Falta teléfono o contenido');

    const contact = await findOrCreateContact(phone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).send('No se pudo crear contacto');

    await linkContactToInbox(contact.id, phone);

    let conversationId = null;
    for (let i = 0; i < 10; i++) {
      conversationId = await getOrCreateConversation(contact.id, phone);
      if (conversationId) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!conversationId) return res.status(500).send('No se pudo crear conversación');

    await sendToChatwoot(conversationId, 'text', `${content}[streamlit]`, true);
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error reflejando mensaje masivo:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
