const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const PORT = 10000;
const tokenWABA = "icCVWtPvpn2Eb9c2C5wjfA4NAK"; // Token de 360dialog
const api360 = "https://waba.360dialog.io/v1/messages";

app.get("/", (_, res) => res.send("✅ Webhook funcionando"));

app.post("/webhook", async (req, res) => {
  const data = req.body;
  console.log("📥 Mensaje recibido:", JSON.stringify(data, null, 2));

  try {
    const messages = data.messages || [];
    for (const message of messages) {
      const from = message.from;
      const text = message.text?.body || "Contenido no soportado";
      const profileName = message?.profile?.name || "Cliente";
      const inboxId = 1; // Ajusta según tu configuración
      const accountId = 1;

      const payload = {
        contact: {
          name: profileName,
          phone_number: from,
        },
        conversation: {
          inbox_id: inboxId,
          source: "whatsapp",
          additional_attributes: {
            identifier: from,
          },
        },
        messages: [
          {
            content: text,
            content_type: "text",
            message_type: "incoming",
            sender: {
              name: profileName,
              phone_number: from,
              additional_attributes: {
                phone_number: from,
              },
            },
          },
        ],
      };

      await axios.post(
        "https://srv870442.hstgr.cloud/public/api/v1/inboxes/1/webhook", // Tu Chatwoot inbox webhook URL
        payload,
        {
          headers: {
            api_access_token: "hERNBAhvrvcwKJW9mRSv3Tsn", // Token de Chatwoot
            "Content-Type": "application/json",
          },
        }
      );
      console.log("✅ Mensaje reenviado a Chatwoot");
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error al reenviar a Chatwoot:", error.message);
    res.sendStatus(500);
  }
});

app.post("/outbound", async (req, res) => {
  const payload = req.body;
  console.log("📤 Mensaje saliente:", JSON.stringify(payload, null, 2));

  try {
    const mensaje = payload.content;
    const numero =
      payload?.conversation?.additional_attributes?.identifier ||
      payload?.sender?.additional_attributes?.phone_number ||
      payload?.sender?.phone_number;

    if (!numero || !mensaje) {
      console.warn("⚠️ No hay número o mensaje, omitiendo envío");
      return res.sendStatus(200);
    }

    const data = {
      to: numero,
      type: "text",
      text: {
        body: mensaje,
      },
    };

    const response = await axios.post(api360, data, {
      headers: {
        Authorization: `Bearer ${tokenWABA}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ Mensaje enviado a WhatsApp:", response.data);
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error enviando a WhatsApp:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook corriendo en puerto ${PORT}`);
  console.log("🌐 Tu servicio está activo");
});
