const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';
const BASE_URL = 'https://srv870442.hstgr.cloud/api/v1/accounts';
const D360_API_URL = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name || 'Cliente WhatsApp';

    if (!msg || msg.from_me) return res.sendStatus(200);

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
      const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, {
        inbox_id: CHATWOOT_INBOX_ID,
        name,
        identifier,
        phone_number: identifier
      }, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contact = resp.data.payload;
    } catch (err) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
    } catch {
      const resp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contact = getResp.data.payload[0];
      contact = resp.data.payload[0];
    }

    if (!contact) return res.sendStatus(500);

    // Vincular al inbox
    // Vincular inbox
    let contactInboxId;
    try {
      const resp = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
@@ -53,11 +55,11 @@ app.post('/webhook', async (req, res) => {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contactInboxId = resp.data.id;
    } catch (err) {
      const getInbox = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
    } catch {
      const resp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contact.id}/contact_inboxes`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      contactInboxId = getInbox.data.payload[0]?.id;
      contactInboxId = resp.data.payload[0]?.id;
    }

    if (!contactInboxId) return res.sendStatus(500);
@@ -72,22 +74,21 @@ app.post('/webhook', async (req, res) => {
    const conversationId = convResp.data.id;
    const type = msg.type;

    // Enviar mensaje
    const payload = {
      message_type: 'incoming',
      private: false
    };

    if (type === 'text') {
      payload.content = msg.text?.body || '[mensaje vacío]';
      payload.content = msg.text.body;
    } else if (type === 'image') {
      payload.attachments = [{ file_type: 'image', file_url: msg.image?.link }];
      payload.attachments = [{ file_type: 'image', file_url: msg.image.link }];
    } else if (type === 'audio') {
      payload.attachments = [{ file_type: 'audio', file_url: msg.audio?.link }];
    } else if (type === 'video') {
      payload.attachments = [{ file_type: 'video', file_url: msg.video?.link }];
      payload.attachments = [{ file_type: 'audio', file_url: msg.audio.link }];
    } else if (type === 'document') {
      payload.attachments = [{ file_type: 'document', file_url: msg.document?.link }];
      payload.attachments = [{ file_type: 'document', file_url: msg.document.link }];
    } else if (type === 'video') {
      payload.attachments = [{ file_type: 'video', file_url: msg.video.link }];
    } else if (type === 'location') {
      const loc = msg.location;
      payload.content = `📍 Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
@@ -101,10 +102,40 @@ app.post('/webhook', async (req, res) => {

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error webhook:', err.response?.data || err.message);
    console.error('❌ Error Webhook:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

app.post('/outbound', async (req, res) => {
  const msg = req.body;

  if (!msg || msg.message_type !== 'outgoing') return res.sendStatus(200);

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
    console.error('❌ Error WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Webhook activo en puerto ${PORT}`));
app.listen(PORT, () => console.log(`🚀 Webhook activo en puerto ${PORT}`));
