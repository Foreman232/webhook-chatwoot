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

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const payload = {
    inbox_id: CHATWOOT_INBOX_ID,
    name,
    identifier: phone,
    phone_number: phone
  };
  try {
    const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return response.data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${phone}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return getResp.data.payload[0];
    }
    console.error(':x: Contacto error:', err.message);
    return null;
  }
}

async function linkContactToInbox(contactId, phone) {
  try {
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      inbox_id: CHATWOOT_INBOX_ID,
      source_id: phone
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    if (!err.response?.data?.message?.includes('has already been taken')) {
      console.error(':x: Inbox link error:', err.message);
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
      inbox_id: CHATWOOT_INBOX_ID
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return newConv.data.id;
  } catch (err) {
    console.error(':x: Error creando conversación:', err.response?.data || err.message);
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

// Webhook entrante desde 360dialog
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = `+${changes?.contacts?.[0]?.wa_id}`;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const contact = await findOrCreateContact(phone, name);
    if (!contact) return res.sendStatus(500);

    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;
    const content = msg[type]?.body || msg[type]?.caption || msg[type]?.link || '[media]';

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

    try {
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content });
    } catch (err) {
      console.error(':x: Error enviando a n8n:', err.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(':x: Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// Reflejo desde Streamlit
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    if (!phone || !content) return res.status(400).send('Falta teléfono o contenido');

    const contact = await findOrCreateContact(phone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).send('No se pudo crear contacto');

    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.status(500).send('No se pudo crear conversación');

    let enviado = false;
    for (let i = 0; i < 5; i++) {
      try {
        await sendToChatwoot(conversationId, 'text', `${content}[streamlit]`, true);
        enviado = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!enviado) return res.status(500).send('No se pudo enviar mensaje a Chatwoot');
    return res.sendStatus(200);
  } catch (err) {
    console.error(':x: Error reflejando mensaje masivo:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
