const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const port = 10000;

// Configuración
const CHATWOOT_API_TOKEN = 'hERNBAhvrvcwKJW9mRSv3Tsn';
const CHATWOOT_ACCOUNT_ID = 1;
const CHATWOOT_INBOX_ID = 1;
const CHATWOOT_URL = 'https://srv870442.hstgr.cloud';
const WHATSAPP_TOKEN = 'icCVWtPvpn2Eb9c2C5wjfA4NAK';

app.use(bodyParser.json());

// Endpoint para mensajes entrantes de WhatsApp (360dialog)
app.post('/webhook', async (req, res) => {
  const mensaje = req.body;
  console.log('📥 Mensaje recibido:', JSON.stringify(mensaje, null, 2));

  try {
    const mensajeTexto = mensaje.messages?.[0]?.text?.body || '';
    const telefono = mensaje.contacts?.[0]?.wa_id;
    const nombre = mensaje.contacts?.[0]?.profile?.name || 'Cliente';

    if (!telefono || !mensajeTexto) {
      return res.sendStatus(200); // No procesamos si falta algo
    }

    // 1. Crear contacto en Chatwoot
    const contacto = await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
      {
        inbox_id: CHATWOOT_INBOX_ID,
        name: nombre,
        identifier: telefono,
        phone_number: telefono,
      },
      {
        headers: {
          api_access_token: CHATWOOT_API_TOKEN,
        },
      }
    );

    const contactId = contacto.data.payload.contact.id;

    // 2. Crear conversación si no existe
    const conversacion = await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
      {
        source_id: telefono,
        inbox_id: CHATWOOT_INBOX_ID,
        contact_id: contactId,
      },
      {
        headers: {
          api_access_token: CHATWOOT_API_TOKEN,
        },
      }
    );

    const conversationId = conversacion.data.id;

    // 3. Enviar mensaje entrante a Chatwoot
    await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        content: mensajeTexto,
        message_type: 'incoming',
      },
      {
        headers: {
          api_access_token: CHATWOOT_API_TOKEN,
        },
      }
    );

    console.log(`✅ Mensaje entrante registrado en Chatwoot para ${telefono}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error procesando mensaje entrante:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Endpoint para mensajes salientes desde Chatwoot hacia WhatsApp
app.post('/outbound', async (req, res) => {
  try {
    const payload = req.body;
    const numero = payload.conversation?.meta?.sender?.id;
    const mensaje = payload.content;

    if (!numero || !mensaje) {
      return res.sendStatus(200); // Ignorar si está incompleto
    }

    await axios.post(
      'https://waba.360dialog.io/v1/messages',
      {
        to: numero,
        type: 'text',
        text: {
          body: mensaje,
        },
      },
      {
        headers: {
          'D360-API-KEY': WHATSAPP_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`📤 Mensaje enviado a WhatsApp: ${numero}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`🚀 Webhook corriendo en puerto ${port}`);
});
