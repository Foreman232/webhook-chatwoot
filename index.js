process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

// === CONFIGURACIÓN ===
const CHATWOOT_API_TOKEN = 'vP4SkyT1VZZVNsYTE6U6xjxP';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '3'; // ← Asegúrate que este sea tu inbox ID real
const BASE_URL = 'https://srv870442.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';

// === FUNCIONES DE APOYO ===
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
    const msg = err.response?.data?.message || '';
    if (msg.includes('has already been taken')) {
      const search = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return search.data.payload[0];
    }
    console.error('❌ Error creando contacto:', err.response?.data || err.message);
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
    const msg = err.response?.data?.message || '';
    if (!msg.includes('has already been taken')) {
      console.error('❌ Error vinculando contacto:', err.response?.data || err.message);
    } else {
      console.log('ℹ️ Contacto ya estaba vinculado al inbox');
    }
  }
}

async function getOrCreateConversation(contactId, sourceId) {
  try {
    const existing = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (existing.data.payload.length > 0) return existing.data.payload[0].id;

    const created = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      inbox_id: CHATWOOT_INBOX_ID
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return created.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.response?.data || err.message);
    return null;
  }
}

async function sendToChatwoot(conversationId, type, content) {
  const payload = {
    message_type: 'incoming',
    private: false
  };

  if (['image', 'document', 'audio', 'video'].includes(type)) {
    payload.attachments = [{ file_type: type, file_url: content }];
  } else {
    payload.content = content;
  }

  try {
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.response?.data || err.message);
  }
}

// === ENTRANTE (WhatsApp → Chatwoot) ===
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];

    if (!phone || !msg /* || msg.from_me */) return res.sendStatus(200);
    console.log(`📥 Mensaje entrante de ${phone}: tipo ${msg.type}`);

    const contact = await findOrCreateContact(phone, name);
    if (!contact) return res.sendStatus(500);

    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;
    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);
    } else if (type === 'image') {
      await sendToChatwoot(conversationId, 'image', msg.image?.link);
    } else if (type === 'document') {
      await sendToChatwoot(conversationId, 'document', msg.document?.link);
    } else if (type === 'audio') {
      await sendToChatwoot(conversationId, 'audio', msg.audio?.link);
    } else if (type === 'video') {
      await sendToChatwoot(conversationId, 'video', msg.video?.link);
    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `📍 Ubicación:\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]');
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error general en webhook:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// === SALIENTE (Chatwoot → WhatsApp) ===
app.post('/outbound', async (req, res) => {
  const msg = req.body;

  if (!msg?.message_type || !['outgoing', 'outgoing_api'].includes(msg.message_type)) {
    return res.sendStatus(200);
  }

  const phone = msg.conversation?.meta?.sender?.phone_number;
  const content = msg.content;

  if (!phone || !content) {
    console.warn('⚠️ Mensaje saliente sin número o contenido, ignorado');
    return res.sendStatus(200);
  }

  const number = phone.replace('+', '');

  try {
    await axios.post(D360_API_URL, {
      recipient_type: "individual",
      to: number,
      type: "text",
      messaging_product: "whatsapp",
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

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
