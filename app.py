import os
import requests
from flask import Flask, request

app = Flask(__name__)

@app.route("/", methods=["POST"])
def webhook():
    data = request.get_json()
    print("\n📩 Mensaje recibido:", data)

    try:
        changes = data["entry"][0]["changes"][0]
        value = changes.get("value", {})

        if "messages" in value and "contacts" in value:
            contact_name = value["contacts"][0]["profile"]["name"]
            phone = value["contacts"][0]["wa_id"]
            message = value["messages"][0]
            message_type = message.get("type")

            if message_type == "text":
                message_text = message["text"]["body"]
            else:
                message_text = f"[Mensaje de tipo {message_type} recibido]"

            payload = {
                "content": message_text,
                "inbox_id": 65391,
                "message_type": "incoming",
                "sender": {
                    "name": contact_name,
                    "identifier": phone
                }
            }

            headers = {
                "Content-Type": "application/json",
                "api_access_token": "8JE48bwAMsyvEihSvjHy6Ag6"
            }

            chatwoot_url = "https://app.chatwoot.com/public/api/v1/inboxes/FmIi9sWlyf5uafK6dmzoj84Qh/messages"
            response = requests.post(chatwoot_url, headers=headers, json=payload)

            print("\n✅ Enviado a Chatwoot:", response.status_code, response.text)
        else:
            print("ℹ️ Ignorado: no es un mensaje entrante")

        return "ok", 200

    except Exception as e:
        print("❌ Error extrayendo mensaje:", e)
        return "invalid", 400
