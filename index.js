app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);

    const messageId = msg.id;

    const contact = await findOrCreateContact(phone, name);
    if (!contact) return res.sendStatus(500);

    const contactInboxId = await linkContactToInbox(contact.id, phone);
    if (!contactInboxId) return res.sendStatus(500);

    const conversationId = await getOrCreateConversation(contactInboxId);
    if (!conversationId) return res.sendStatus(500);

    const type = msg.type;

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);
    } else if (type === 'image') {
      await sendToChatwoot(conversationId, 'image', msg.image?.link);
    } else if (type === 'document') {
      await sendToChatwoot(conversationId, 'document', msg.document?.link);
    } else if (type === 'audio') {
      const audioLink = msg.audio?.link;
      await sendToChatwoot(conversationId, 'audio', audioLink || 'Nota de voz recibida');

      const base64Audio = await audioToBase64(audioLink);
      try {
        await axios.post(N8N_WEBHOOK_URL, {
          phone,
          name,
          type,
          Voice: base64Audio || null,
          content: audioLink || '[audio]',
          messageId,
          conversationId
        });
      } catch (n8nErr) {
        console.error('❌ Error enviando audio a n8n:', n8nErr.message);
      }

      return res.sendStatus(200);
    } else if (type === 'video') {
      await sendToChatwoot(conversationId, 'video', msg.video?.link);
    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `Ubicación recibida 📍\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]');
    }

    if (type !== 'audio') {
      try {
        await axios.post(N8N_WEBHOOK_URL, {
          phone,
          name,
          type,
          content: msg[type]?.body || msg[type]?.caption || msg[type]?.link || '[media]',
          messageId,
          conversationId
        });
      } catch (n8nErr) {
        console.error('❌ Error enviando a n8n:', n8nErr.message);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    res.sendStatus(500);
  }
});
