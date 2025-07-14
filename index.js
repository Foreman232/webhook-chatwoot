const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

// CONFIGURACIÓN
const CHATWOOT_API_TOKEN = 'orUPYDWoDBkCShVrTSRUZsRx';
const CHATWOOT_ACCOUNT_ID = '1';
const CHATWOOT_INBOX_ID = '1';

const processedMessages = new Set();

// Buscar o crear contacto
function normalizePhone(phone) {
  return phone.startsWith('+521') ? '+52' + phone.slice(4) : phone;
}

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = phone;
  const identifier = normalizePhone(phone);
const payload = {
inbox_id: CHATWOOT_INBOX_ID,
name,
}
}

// Vincular contacto al inbox
async function linkContactToInbox(contactId, phone) {
  const normalized = normalizePhone(phone);
try {
await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
inbox_id: CHATWOOT_INBOX_ID,
      source_id: phone
      source_id: normalized
}, {
headers: { api_access_token: CHATWOOT_API_TOKEN }
});
}
}

// Obtener o crear conversación con reintento
async function getOrCreateConversation(contactId, sourceId) {
async function getOrCreateConversation(contactId, phone) {
  const normalized = normalizePhone(phone);
try {
const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
headers: { api_access_token: CHATWOOT_API_TOKEN }
});
if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;

const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      source_id: normalized,
inbox_id: CHATWOOT_INBOX_ID,
contact_id: contactId
}, {

}
}

// Enviar mensaje a Chatwoot
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
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    const conversationId = await getOrCreateConversation(contact.id, phone);
if (!conversationId) return res.sendStatus(500);

const type = msg.type;

}
});

// Mensajes salientes desde Chatwoot hacia WhatsApp
app.post('/outbound', async (req, res) => {
const msg = req.body;

if (!msg?.message_type || msg.message_type !== 'outgoing' || msg.content?.includes('[streamlit]')) {
return res.sendStatus(200);
}

}
});

// Reflejo de mensajes enviados desde Streamlit
app.post('/send-chatwoot-message', async (req, res) => {
try {
const { phone, name, content } = req.body;


await linkContactToInbox(contact.id, phone);

    // Esperar activamente hasta que la conversación esté lista
let conversationId = null;
for (let i = 0; i < 5; i++) {
      conversationId = await getOrCreateConversation(contact.id, contact.identifier);
      conversationId = await getOrCreateConversation(contact.id, phone);
if (conversationId) break;
await new Promise(resolve => setTimeout(resolve, 1000));
}
