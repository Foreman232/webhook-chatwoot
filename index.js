const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https'); // <-- Para manejar certificados autofirmados
const app = express();
app.use(bodyParser.json());

const CHATWOOT_API_TOKEN = '5ZSLaX4VCt4T2Z1aHRyPmTFb';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv904439.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'I7yNB2t4EpJlPqxHF82mWXYTAK';
const N8N_WEBHOOK_URL = 'https://n8n.srv876216.hstgr.cloud/webhook-test/02cfb95c-e80b-4a83-ad98-35a8fe2fb2fb';

const processedMessages = new Set();

function normalizarNumero(numero) {
  if (!numero || typeof numero !== 'string') return '';
  if (numero.startsWith("+52") && !numero.startsWith("+521")) {
    return "+521" + numero.slice(3);
  }
  return numero;
}

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = normalizarNumero(phone);
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
    console.error(':x: Contacto error:', err.message);
    return null;
  }
}

async function getSourceId(contactId) {
  try {
    const res = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return res.data.payload.contact_inboxes?.[0]?.source_id || '';
  } catch (err) {
    console.error('❌ No se pudo obtener el source_id desde Chatwoot:', err.message);
    return '';
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

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const rawPhone = `+${changes?.contacts?.[0]?.wa_id}`;
    const phone = normalizarNumero(rawPhone);
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];

    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const messageId = msg.id;
    if (processedMessages.has(messageId)) return res.sendStatus(200);
    processedMessages.add(messageId);

    const contact = await findOrCreateContact(phone, name);
    if (!contact || !contact.id) return res.sendStatus(500);

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) return res.sendStatus(500);

    const conversationId = await getOrCreateConversation(contact.id, sourceId);
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
      await axios.post(N8N_WEBHOOK_URL, { phone, name, type, content }, {
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
      });
    } catch (n8nErr) {
      console.error(':x: Error enviando a n8n:', n8nErr.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(':x: Webhook error:', err.message);
    res.sendStatus(500);
  }
});

app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
    return res.sendStatus(200);
  }

  const messageId = msg.id;
  const rawNumber = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const number = normalizarNumero(`+${rawNumber}`).replace('+', '');
  const content = msg.content;

  if (processedMessages.has(messageId)) return res.sendStatus(200);
  processedMessages.add(messageId);

  if (!number || !content) return res.sendStatus(200);

  try {
    console.log(`📤 Enviando a WhatsApp: ${number} | ${content}`);
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
    console.error(':x: Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

app.post('/send-chatwoot-message', async (req, res) => {
  try {
    const { phone, name, content } = req.body;
    const normalizedPhone = normalizarNumero(phone.trim());

    console.log("📥 Reflejando mensaje desde Streamlit:", {
      phone: normalizedPhone,
      name,
      content
    });

    const contact = await findOrCreateContact(normalizedPhone, name || 'Cliente WhatsApp');
    if (!contact || !contact.id) {
      console.error(':x: Contacto inválido o no creado correctamente:', contact);
      return res.status(500).send('Error al crear o recuperar el contacto');
    }

    const sourceId = contact.contact_inboxes?.[0]?.source_id || await getSourceId(contact.id);
    if (!sourceId) {
      console.error(':x: No se encontró source_id en contact_inboxes');
      return res.status(500).send('No se pudo obtener source_id');
    }

    let conversationId = null;
    for (let i = 0; i < 5; i++) {
      conversationId = await getOrCreateConversation(contact.id, sourceId);
      if (conversationId) {
        try {
          const check = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
            headers: { api_access_token: CHATWOOT_API_TOKEN }
          });
          if (check.status === 200) break;
        } catch (err) {
          console.warn(`⏳ Conversación aún no lista... intento ${i + 1}`);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!conversationId) {
      console.error(':x: No se logró crear conversación tras varios intentos');
      return res.status(500).send('No se pudo crear conversación');
    }

    await sendToChatwoot(conversationId, 'text', `${content}[streamlit]`, true);

    try {
      await axios.put(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}`, {
        status: 'open'
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });

      await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`, {
        assignee_id: null
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
    } catch (err) {
      console.warn(':warning: No se pudo forzar visibilidad de la conversación en bandeja:', err.message);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error(':x: Error general en /send-chatwoot-message:', err.message);
    res.status(500).send('Error interno al reflejar mensaje');
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
