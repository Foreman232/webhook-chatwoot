const app = express();
app.use(bodyParser.json());

// ✅ CONFIGURACIÓN ACTUALIZADA
const CHATWOOT_API_TOKEN = 'vP4SkyT1VZZVNsYTE6U6xjxP';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv870442.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';

app.post('/webhook', async (req, res) => {
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
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const msg = changes?.messages?.[0];
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name || 'Cliente WhatsApp';

    if (!msg || msg.from_me) return res.sendStatus(200);

    const identifier = `+${phone}`;

    // Crear o buscar contacto
    let contact;
    try {
      const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, {
        inbox_id: CHATWOOT_INBOX_ID,
        name,
        identifier,
        phone_number: identifier
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contact = resp.data.payload;
    } catch {
      const resp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
    const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return response.data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contact = resp.data.payload[0];
      return getResp.data.payload[0];
    }
    console.error('❌ Contacto error:', err.message);
    return null;
  }
}

    if (!contact) return res.sendStatus(500);

    // Vincular inbox
    let contactInboxId;
    try {
      const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
        inbox_id: CHATWOOT_INBOX_ID,
        source_id: identifier
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contactInboxId = resp.data.id;
    } catch {
      const resp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contactInboxId = resp.data.payload[0]?.id;
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

    if (!contactInboxId) return res.sendStatus(500);

    // Crear conversación
    const convResp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      contact_inbox_id: contactInboxId
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
    console.error('❌ Error creando conversación:', err.message);
    return null;
  }
}

    const conversationId = convResp.data.id;
    const type = msg.type;

async function sendToChatwoot(conversationId, type, content) {
  try {
    const payload = {
      content,
      message_type: 'incoming',
      private: false
    };
    if (['image', 'document', 'audio', 'video'].includes(type)) {
      payload.attachments = [{ file_type: type, file_url: content }];
      delete payload.content;
    }
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.message);
  }
}

// ✅ Webhook entrante desde 360dialog
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
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;

    if (type === 'text') {
      payload.content = msg.text.body;
      await sendToChatwoot(conversationId, 'text', msg.text.body);
    } else if (type === 'image') {
      payload.attachments = [{ file_type: 'image', file_url: msg.image.link }];
    } else if (type === 'audio') {
      payload.attachments = [{ file_type: 'audio', file_url: msg.audio.link }];
      await sendToChatwoot(conversationId, 'image', msg.image?.link || 'Imagen recibida');
    } else if (type === 'document') {
      payload.attachments = [{ file_type: 'document', file_url: msg.document.link }];
      await sendToChatwoot(conversationId, 'document', msg.document?.link || 'Documento recibido');
    } else if (type === 'audio') {
      await sendToChatwoot(conversationId, 'audio', msg.audio?.link || 'Nota de voz recibida');
    } else if (type === 'video') {
      payload.attachments = [{ file_type: 'video', file_url: msg.video.link }];
      await sendToChatwoot(conversationId, 'video', msg.video?.link || 'Video recibido');
    } else if (type === 'location') {
      const loc = msg.location;
      payload.content = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      const locStr = `Ubicación recibida 📍\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);
    } else {
      payload.content = '[Contenido no soportado]';
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]');
    }

    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    // ✅ También lo enviamos a n8n
    try {
      await axios.post(N8N_WEBHOOK_URL, {
        phone,
        name,
        type,
        content: msg[type]?.body || msg[type]?.caption || msg[type]?.link || '[media]'
      });
    } catch (n8nErr) {
      console.error('❌ Error enviando a n8n:', n8nErr.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error Webhook:', err.response?.data || err.message);
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// ✅ Mensaje saliente desde Chatwoot hacia WhatsApp (360dialog)
app.post('/outbound', async (req, res) => {
  const msg = req.body;

  if (!msg || msg.message_type !== 'outgoing') return res.sendStatus(200);
  if (!msg?.message_type || msg.message_type !== 'outgoing') return res.sendStatus(200);

  const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content = msg.content;

  if (!number || !content) return res.sendStatus(200);

  try {
@@ -132,10 +172,10 @@ app.post('/outbound', async (req, res) => {
    console.log(`✅ Enviado a WhatsApp: ${content}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error WhatsApp:', err.response?.data || err.message);
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook activo en puerto ${PORT}`));
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
