import os
import requests
from flask import Flask, request

app = Flask(__name__)

@app.route("/", methods=["GET"])
def home():
    return "Webhook activo ✅", 200

@app.route("/", methods=["POST"])
def webhook():
    data = request.get_json()
    print("\n📩 Mensaje recibido:", data)

    try:
        value = data["entry"][0]["changes"][0]["value"]
        contact_name = value["contacts"][0]["profile"]["name"]
        phone = value["contacts"][0]["wa_id"]
        message_text = value["messages"][0]["text"]["body"]

        payload = {
            "inbox_id": 65391,
            "source_id": phone,
            "contact": {
                "name": contact_name,
                "phone_number": phone
            },
            "content": message_text
        }

        headers = {
            "Content-Type": "application/json",
            "api_access_token": "8JE48bwAMsyvEihSvjHy6Ag6"
        }

        chatwoot_url = "https://app.chatwoot.com/public/api/v1/inboxes/FmIi9sWlyf5uafK6dmzoj84Qh/messages"

        response = requests.post(chatwoot_url, json=payload, headers=headers)

        print("\n✅ Enviado a Chatwoot:", response.status_code, response.text)
        return "ok", 200

    except Exception as e:
        print("❌ Error extrayendo mensaje:", e)
        return "invalid", 400

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000)
