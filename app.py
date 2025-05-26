import os
import requests
from flask import Flask, request

app = Flask(__name__)

# Cargar las variables de entorno configuradas en Render
CHATWOOT_API_KEY = os.getenv("CHATWOOT_API_KEY")            # 8JE48bwAMsyvEihSvjHy6Ag6
CHATWOOT_ACCOUNT_ID = os.getenv("CHATWOOT_ACCOUNT_ID")      # 122053
CHATWOOT_INBOX_IDENTIFIER = os.getenv("CHATWOOT_INBOX_IDENTIFIER")  # FmIi9sWlyf5uafK6dmzoj84Qh

@app.route("/", methods=["GET"])
def home():
    return "✅ Webhook de WhatsApp activo", 200

@app.route("/", methods=["POST"])
def webhook():
    data = request.get_json()
    print("📩 Mensaje recibido:", data)

    try:
        contact_name = data["entry"][0]["changes"][0]["value"]["contacts"][0]["profile"]["name"]
        phone = data["entry"][0]["changes"][0]["value"]["contacts"][0]["wa_id"]
        message_text = data["entry"][0]["changes"][0]["value"]["messages"][0]["text"]["body"]
    except Exception as e:
        print("❌ Error extrayendo mensaje:", e)
        return "Invalid payload", 400

    # Enviar mensaje a Chatwoot usando inbox_identifier
    url = f"https://app.chatwoot.com/public/api/v1/inboxes/{CHATWOOT_INBOX_IDENTIFIER}/webhooks"

    headers = {
        "Content-Type": "application/json",
        "api_access_token": CHATWOOT_API_KEY
    }

    payload = {
        "sender": {
            "name": contact_name,
            "identifier": phone,
            "phone_number": phone,
            "additional_attributes": {}
        },
        "message": {
            "content": message_text
        }
    }

    response = requests.post(url, json=payload, headers=headers)
    print("✅ Enviado a Chatwoot:", response.status_code, response.text)

    return "OK", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000)
