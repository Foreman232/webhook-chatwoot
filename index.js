const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// CONFIG
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

async function getOrCreateConversation(contactId, phone) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: `+${phone}`,
      inbox_id: CHATWOOT_INBOX_ID
    }, {
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

// ✅ Webhook oficial desde 360dialog (no tocar)
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const contact = await findOrCreateContact(phone, name);
    if (!contact) return res.sendStatus(500);

    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, phone);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;
    const content = msg[type]?.body || msg[type]?.caption || msg[type]?.link || '[media]';

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido multimedia]');
    }

    await axios.post(N8N_WEBHOOK_URL, {
      phone,
      name,
      type,
      content
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ✅ Webhook saliente desde Chatwoot hacia WhatsApp (360dialog)
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing') return res.sendStatus(200);

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
    console.log(`✅ Enviado a WhatsApp: ${content}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ✅ NUEVO: Reflejo desde Streamlit sin romper nada
app.post('/send-chatwoot-message', async (req, res) => {
  const { phone, name, content } = req.body;
  const cleanPhone = phone.replace('+', '').replace(/\D/g, '');
  try {
    const contact = await findOrCreateContact(cleanPhone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).send('Error creando contacto');

    await linkContactToInbox(contact.id, cleanPhone);
    const conversationId = await getOrCreateConversation(contact.id, cleanPhone);
    if (!conversationId) return res.status(500).send('Error conversación');

    await sendToChatwoot(conversationId, 'text', content);
    console.log(`✅ Reflejado: ${cleanPhone} → ${content}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Fallo reflejo masivo:', err.message);
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
