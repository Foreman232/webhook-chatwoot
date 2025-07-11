// ✅ index.js actualizado y corregido para Chatwoot + 360dialog + Streamlit

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ✅ CONFIGURACIÓN
const CHATWOOT_API_TOKEN = 'orUPYDWoDBkCShVrTSRUZsRx';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv904439.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';
const N8N_WEBHOOK_URL = 'https://n8n.srv869869.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

const lastMessageMap = new Map();

// ✅ Crear o buscar contacto en Chatwoot
async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = `+${phone}`;
  const payload = {
    inbox_id: CHATWOOT_INBOX_ID,
    name,
    identifier,
    phone_number: identifier
  };
  try {
    const res = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return res.data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const search = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return search.data.payload[0];
    }
    console.error('❌ Contacto error:', err.message);
    return null;
  }
}

// ✅ Vincular contacto a inbox y obtener contact_inbox_id
async function linkContactToInbox(contactId, phone) {
  try {
    const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      inbox_id: CHATWOOT_INBOX_ID,
      source_id: `+${phone}`
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return response.data.payload.id;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const res = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return res.data.payload?.[0]?.id;
    } else {
      console.error('❌ Inbox link error:', err.message);
      return null;
    }
  }
}

// ✅ Crear o reutilizar conversación
async function getOrCreateConversation(contactInboxId) {
  try {
    const res = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contact_inboxes/${contactInboxId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (res.data.payload.length > 0) return res.data.payload[0].id;

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contact_inboxes/${contactInboxId}/conversations`, {}, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return newConv.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.message);
    return null;
  }
}

// ✅ Enviar mensaje a Chatwoot
async function sendToChatwoot(conversationId, type, content, outgoing = false) {
  try {
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
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.message);
  }
}

// ✅ Webhook entrante 360dialog
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const messages = changes?.messages;

    if (!phone || !messages) return res.sendStatus(200);

    for (const msg of messages) {
      if (!msg.type || !msg.id || msg.from_me) continue;
      const last = lastMessageMap.get(phone);
      if (last && last.id === msg.id) continue;
      lastMessageMap.set(phone, { id: msg.id, timestamp: Date.now() });

      const contact = await findOrCreateContact(phone, name);
      if (!contact) continue;

      const contactInboxId = await linkContactToInbox(contact.id, phone);
      if (!contactInboxId) continue;

      const conversationId = await getOrCreateConversation(contactInboxId);
      if (!conversationId) continue;

      let content = '[media]';
      const type = msg.type;
      if (type === 'text') content = msg.text.body;
      else if (type === 'image') content = msg.image?.link || '[imagen]';
      else if (type === 'document') content = msg.document?.link || '[documento]';
      else if (type === 'audio') content = msg.audio?.link || '[audio]';
      else if (type === 'video') content = msg.video?.link || '[video]';
      else if (type === 'location') content = `📍 https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}`;

      await sendToChatwoot(conversationId, type, content);

      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ✅ Mensajes salientes desde Chatwoot a WhatsApp
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) return res.sendStatus(200);
  const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content = msg.content;
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
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ✅ Endpoint para Streamlit
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    if (!phone || !content) return res.status(400).send('Falta teléfono o contenido');
    const contact = await findOrCreateContact(phone, name || 'Cliente');
    const contactInboxId = await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contactInboxId);
    await sendToChatwoot(conversationId, 'text', `${content} [streamlit]`, true);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error /send-chatwoot-message:', err.message);
    res.status(500).send('Error reflejando mensaje en Chatwoot');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
