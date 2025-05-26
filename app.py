import os
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

CHATWOOT_API_KEY = os.getenv("CHATWOOT_API_KEY")
CHATWOOT_ACCOUNT_ID = os.getenv("CHATWOOT_ACCOUNT_ID")
CHATWOOT_INBOX_IDENTIFIER = os.getenv("CHATWOOT_INBOX_IDENTIFIER")  # OJO, esto lo agregaste en tus variables de entorno

@app.route("/", methods=["GET"])
def home():
    return "Webhook activo ✅", 200

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
        return "invalid", 400

    # Paso 1: Crear contacto e iniciar conversación
    url = f"https://app.chatwoot.com/public/api/v1/inboxes/{CHATWOOT_INBOX_IDENTIFIER}/contacts"
    headers = {
        "Content-Type": "application/json",
        "api_access_token": CHATWOOT_API_KEY
    }
    payload = {
        "identifier": phone,
        "name": contact_name,
        "phone_number": phone,
        "custom_attributes": {}
    }

    contact_response = requests.post(url, json=payload, headers=headers)
    print("👤 Contacto creado:", contact_response.status_code, contact_response.text)

    if contact_response.status_code != 200:
        return "failed to create contact", 400

    source_id = contact_response.json().get("source_id")

    # Paso 2: Enviar mensaje entrante
    message_url = f"https://app.chatwoot.com/public/api/v1/inboxes/{CHATWOOT_INBOX_IDENTIFIER}/messages"
    message_payload = {
        "content": message_text,
        "inbox_identifier": CHATWOOT_INBOX_IDENTIFIER,
        "message_type": "incoming",
        "sender": {
            "name": contact_name,
            "phone_number": phone,
            "identifier": phone
        }
    }

    message_response = requests.post(message_url, json=message_payload, headers=headers)
    print("✅ Mensaje enviado:", message_response.status_code, message_response.text)

    return "ok", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000)
