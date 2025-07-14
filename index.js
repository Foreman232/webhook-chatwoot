const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Configuración
const CHATWOOT_API_TOKEN = 'orUPYDWoDBkCShVrTSRUZsRx';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';


const recentlySent = new Set();

// Buscar o crear contacto
async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = phone; // sin '+'
  const identifier = `+${phone}`;
const payload = {
inbox_id: CHATWOOT_INBOX_ID,
name,
identifier,
    phone_number: `+${phone}` // visualización amigable
    phone_number: identifier
};
try {
const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, {

}
}

// Vincular contacto con inbox
async function linkContactToInbox(contactId, phone) {
try {
await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
inbox_id: CHATWOOT_INBOX_ID,
      source_id: phone // sin '+'
      source_id: `+${phone}`
}, {
headers: { api_access_token: CHATWOOT_API_TOKEN }
});

}
}

// Obtener o crear conversación
async function getOrCreateConversation(contactId, sourceId) {
try {
const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
headers: { api_access_token: CHATWOOT_API_TOKEN }
});
if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;

    const inboxRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    const contactInboxId = inboxRes.data.payload[0]?.id;
    if (!contactInboxId) throw new Error('No se encontró contact_inbox_id');

const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      inbox_id: CHATWOOT_INBOX_ID
      contact_inbox_id: contactInboxId
}, {
headers: { api_access_token: CHATWOOT_API_TOKEN }
});

return newConv.data.id;

} catch (err) {
    console.error('❌ Error creando conversación:', err.message);
    console.error('❌ Error creando conversación:', err.response?.data || err.message);
return null;
}
}

// Enviar a Chatwoot
async function sendToChatwoot(conversationId, type, content, outgoing = false) {
try {
const payload = {

}
}

// Webhook entrante desde 360dialog
app.post('/webhook', async (req, res) => {
try {
const entry = req.body.entry?.[0];

const contact = await findOrCreateContact(phone, name);
if (!contact) return res.sendStatus(500);
await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
if (!conversationId) return res.sendStatus(500);

const type = msg.type;
}
});

// Mensaje saliente desde Chatwoot hacia WhatsApp
app.post('/outbound', async (req, res) => {
try {
const msg = req.body;

}
});

// Reflejar mensaje desde Streamlit (masivo)
app.post('/send-chatwoot-message', async (req, res) => {
try {
const { phone, name, content } = req.body;
if (!phone || !content) return res.status(400).send('Falta teléfono o contenido');
const contact = await findOrCreateContact(phone, name || 'Cliente WhatsApp');
if (!contact) return res.status(500).send('No se pudo crear contacto');
await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
if (!conversationId) return res.status(500).send('No se pudo crear conversación');
await sendToChatwoot(conversationId, 'text', content + ' [streamlit]', true);
return res.sendStatus(200);
}
});

// Iniciar servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
