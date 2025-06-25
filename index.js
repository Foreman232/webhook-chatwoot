const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const CHATWOOT_API_TOKEN = 'vP4SkyT1VZZVNsYTE6U6xjxP';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv870442.hstgr.cloud/api/v1/accounts';

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const identifier = `+${phone}`;
    const contactPayload = {
      inbox_id: CHATWOOT_INBOX_ID,
      name: name || 'Cliente WhatsApp',
      identifier,
      phone_number: identifier
    };

    // Crear o buscar contacto
    let contact;
    try {
      const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, contactPayload, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contact = resp.data.payload;
    } catch (err) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contact = getResp.data.payload[0];
    }

    if (!contact) return res.sendStatus(500);

    // Vincular al inbox
    let contactInboxId;
    try {
      const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
        inbox_id: CHATWOOT_INBOX_ID,
        source_id: identifier
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contactInboxId = resp.data.id;
    } catch (err) {
      const getInbox = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contactInboxId = getInbox.data.payload[0]?.id;
    }

    if (!contactInboxId) return res.sendStatus(500);

    // Crear conversación
    const convResp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      contact_inbox_id: contactInboxId
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    const conversationId = convResp.data.id;
    const type = msg.type;

    // Enviar mensaje
    const payload = {
      message_type: 'incoming',
      private: false
    };

    if (type === 'text') {
      payload.content = msg.text?.body || '[mensaje vacío]';
    } else if (type === 'image') {
      payload.attachments = [{ file_type: 'image', file_url: msg.image?.link }];
    } else if (type === 'audio') {
      payload.attachments = [{ file_type: 'audio', file_url: msg.audio?.link }];
    } else if (type === 'video') {
      payload.attachments = [{ file_type: 'video', file_url: msg.video?.link }];
    } else if (type === 'document') {
      payload.attachments = [{ file_type: 'document', file_url: msg.document?.link }];
    } else if (type === 'location') {
      const loc = msg.location;
      payload.content = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
    } else {
      payload.content = '[Contenido no soportado]';
    }

    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error webhook:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Webhook activo en puerto ${PORT}`));
