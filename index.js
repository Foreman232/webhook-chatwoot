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

async function getOrCreateConversation(contactId, phone) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;

    const inboxRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    const contactInbox = inboxRes.data.payload.find(
      inbox => inbox.inbox_id.toString() === CHATWOOT_INBOX_ID
    );

    if (!contactInbox) throw new Error(`❌ No se encontró contact_inbox_id válido para inbox ${CHATWOOT_INBOX_ID}`);

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      contact_inbox_id: contactInbox.id
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    return newConv.data.id;

  } catch (err) {
    console.error('❌ Error creando conversación:', err.response?.data || err.message);
    return null;
  }
}

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

app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    if (!phone || !content) return res.status(400).send('Falta teléfono o contenido');

    const cleanPhone = phone.replace('+', '');
    const contact = await findOrCreateContact(cleanPhone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).send('No se pudo crear contacto');

    await linkContactToInbox(contact.id, cleanPhone);

    const conversationId = await getOrCreateConversation(contact.id, cleanPhone);
    if (!conversationId) return res.status(500).send('No se pudo obtener conversación');

    await sendToChatwoot(conversationId, 'text', content + ' [streamlit]', true);
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error reflejando mensaje masivo:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
