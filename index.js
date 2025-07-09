const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ✅ CONFIGURACIÓN ACTUALIZADA
const CHATWOOT_API_TOKEN = 'vP4SkyT1VZZVNsYTE6U6xjxP';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv870442.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';
const N8N_WEBHOOK_URL = 'https://n8n.srv869869.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = `+${phone}`;
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
  try {
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      inbox_id: CHATWOOT_INBOX_ID,
      source_id: `+${phone}`
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    if (!err.response?.data?.message?.includes('has already been taken')) {
      console.error('❌ Inbox link error:', err.message);
    }
  }
}

async function getOrCreateConversation(contactId, sourceId) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;
    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      source_id,
      inbox_id: CHATWOOT_INBOX_ID
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
@@ -148,32 +148,50 @@
  }
});

// ✅ Mensaje saliente desde Chatwoot hacia WhatsApp (360dialog)
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing') return res.sendStatus(200);

  const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content = msg.content;
  if (!number || !content) return res.sendStatus(200);
// ✅ Endpoint para reflejar mensajes salientes desde Streamlit
app.post('/send-chatwoot-message', async (req, res) => {
  const { phone, name, message } = req.body;

  try {
    await axios.post(D360_API_URL, {
      messaging_product: 'whatsapp',
      to: number,
      type: 'text',
      text: { body: content }
    const contact = await findOrCreateContact(phone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).send('No se pudo crear el contacto');

    await linkContactToInbox(contact.id, phone);

    const inboxRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    const contact_inbox_id = inboxRes.data.payload[0].id;

    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    let conversationId;
    if (convRes.data.payload.length > 0) {
      conversationId = convRes.data.payload[0].id;
    } else {
      const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
        contact_inbox_id
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      conversationId = newConv.data.id;
    }

    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
      content: message,
      message_type: 'outgoing',
      private: false
    }, {
      headers: {
        'D360-API-KEY': D360_API_KEY,
        'Content-Type': 'application/json'
      }
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    console.log(`✅ Enviado a WhatsApp: ${content}`);
    res.sendStatus(200);

    console.log(`✅ Reflejado en Chatwoot: ${phone}`);
    res.send({ success: true });
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
    console.error('❌ Error en /send-chatwoot-message:', err.message);
    res.status(500).send('Error reflejando mensaje en Chatwoot');
  }
});
