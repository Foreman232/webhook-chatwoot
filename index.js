const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const app = express();
const PORT = 10000;

// Configuración de Chatwoot
const CHATWOOT_URL = "https://srv870442.hstgr.cloud";
const CHATWOOT_TOKEN = "hERNBAhvrvcwKJW9mRSv3Tsn";
const ACCOUNT_ID = 1;
const INBOX_ID = 1;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const data = req.body;

  try {
    const from = data.messages?.[0]?.from;
    const msg = data.messages?.[0]?.text?.body || "Contenido no textual";
    const nombre = data.contacts?.[0]?.profile?.name || "Cliente";

    if (!from || !msg) return res.sendStatus(200);

    const identificador = `whatsapp:${from}`;

    // Verifica si el contacto ya existe
    const contactResponse = await axios.get(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/contacts/search?q=${identificador}`,
      {
        headers: {
          api_access_token: CHATWOOT_TOKEN,
        },
      }
    );

    let contactId;

    if (contactResponse.data.payload.length > 0) {
      contactId = contactResponse.data.payload[0].id;
    } else {
      // Si no existe, crear el contacto
      const createContact = await axios.post(
        `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/contacts`,
        {
          inbox_id: INBOX_ID,
          name: nombre,
          identifier: identificador,
          phone_number: from,
        },
        {
          headers: {
            api_access_token: CHATWOOT_TOKEN,
          },
        }
      );
      contactId = createContact.data.id;
    }

    // Verifica si ya hay una conversación abierta
    const convResponse = await axios.get(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/contacts/${contactId}/conversations`,
      {
        headers: {
          api_access_token: CHATWOOT_TOKEN,
        },
      }
    );

    let conversationId;

    if (convResponse.data.length > 0) {
      conversationId = convResponse.data[0].id;
    } else {
      // Crear nueva conversación
      const createConv = await axios.post(
        `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations`,
        {
          source_id: contactId,
          inbox_id: INBOX_ID,
        },
        {
          headers: {
            api_access_token: CHATWOOT_TOKEN,
          },
        }
      );
      conversationId = createConv.data.id;
    }

    // Crear mensaje entrante
    await axios.post(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`,
      {
        content: msg,
        message_type: "incoming",
      },
      {
        headers: {
          api_access_token: CHATWOOT_TOKEN,
        },
      }
    );

    console.log(`✅ Mensaje recibido: ${msg} de ${from}`);
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Webhook corriendo en puerto ${PORT}`);
});
