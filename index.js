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

const recentlySent = new Set();

// 🔍 Buscar o crear contacto
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

// 📌 Vincular contacto con inbox
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

// 💬 Obtener o crear conversación
async function getOrCreateConversation(contactId, sourceId) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;

    const inboxRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    const inboxPayload = inboxRes.data.payload;
    if (!inboxPayload || inboxPayload.length === 0) {
      throw new Error('❌ No se encontró ningún contact_inbox_id');
    }
    const contactInboxId = inboxPayload[0].id;

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      contact_inbox_id: contactInboxId
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    return newConv.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.message);
    return null;
  }
}

// ✉️ Enviar mensaje a Chatwoot
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

// 📥 Webhook de mensajes entrantes desde WhatsApp
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
    await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo

    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);

    const type = msg.type;
    const defaultText = '[Contenido no soportado]';
    let content = '';

    if (type === 'text') content = msg.text.body;
    else if (type === 'image') content = msg.image?.link || 'Imagen recibida';
    else if (type === 'document') content = msg.document?.link || 'Documento recibido';
    else if (type === 'audio') content = msg.audio?.link || 'Nota de voz recibida';
    else if (type === 'video') content = msg.video?.link || 'Video recibido';
    else if (type === 'location') content = `📍 Ubicación: https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}`;
    else content = defaultText;

    if (conversationId) {
      await sendToChatwoot(conversationId, type === 'location' ? 'text' : type, content);
    }

    try {
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content });
    } catch (n8nErr) {
      console.error('❌ Error enviando a n8n:', n8nErr.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// 📤 Webhook de salida desde Chatwoot
app.post('/outbound', async (req, res) => {
  try {
    const msg = req.body;
    if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
      return res.sendStatus(200);
    }

    const uniqueKey = `msg-${msg.id}`;
    if (recentlySent.has(uniqueKey)) return res.sendStatus(200);
    recentlySent.add(uniqueKey);
    setTimeout(() => recentlySent.delete(uniqueKey), 10000);

    const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
    const content = msg.content;
    const messageId = msg.id;

    if (!number || !content) return res.sendStatus(400);

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

    await axios.patch(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${msg.conversation.id}/messages/${messageId}`, {
      external_source_id: 'sent-to-whatsapp'
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// 📨 Endpoint para reflejar envíos desde Streamlit
app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    if (!phone || !content) return res.status(400).send('Falta teléfono o contenido');

    const contact = await findOrCreateContact(phone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).send('No se pudo crear contacto');

    await linkContactToInbox(contact.id, phone);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo

    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.status(500).send('No se pudo generar conversación');

    await sendToChatwoot(conversationId, 'text', content + ' [streamlit]', true);
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error reflejando mensaje masivo:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

// 🚀 Iniciar servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
