const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const CHATWOOT_API_TOKEN = 'vP4SkyT1VZZVNsYTE6U6xjxP';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv870442.hstgr.cloud/api/v1/accounts';
const N8N_WEBHOOK_URL = 'https://n8n.srv869869.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = `${phone}`;
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
    const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      inbox_id: CHATWOOT_INBOX_ID,
      source_id: `${phone}`
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return response.data.payload.id; // 👈 ID del contact_inbox necesario
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const inboxes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return inboxes.data.payload.find(ci => ci.inbox_id === parseInt(CHATWOOT_INBOX_ID))?.id;
    } else {
      console.error('❌ Inbox link error:', err.message);
      return null;
    }
  }
}

async function getOrCreateConversation(contactInboxId) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contact_inboxes/${contactInboxId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contact_inboxes/${contactInboxId}/conversations`, {}, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return newConv.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.message);
    return null;
  }
}

async function sendToChatwoot(conversationId, type, content) {
  try {
    const payload = {
      content,
      message_type: 'incoming',
      private: false
    };
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.message);
  }
}

app.post('/send-chatwoot-message', async (req, res) => {
  const { phone, name, message } = req.body;
  if (!phone || !message) return res.status(400).send('Falta teléfono o mensaje');

  try {
    const contact = await findOrCreateContact(phone, name || 'Cliente');
    if (!contact) return res.status(500).send('No se pudo crear contacto');

    const contactInboxId = await linkContactToInbox(contact.id, phone);
    if (!contactInboxId) return res.status(500).send('No se pudo obtener contact_inbox');

    const conversationId = await getOrCreateConversation(contactInboxId);
    if (!conversationId) return res.status(500).send('No se pudo crear conversación');

    await sendToChatwoot(conversationId, 'text', message);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error en /send-chatwoot-message:', err.message);
    res.status(500).send('Error reflejando mensaje en Chatwoot');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
