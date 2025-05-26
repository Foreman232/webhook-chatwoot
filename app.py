import os
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

CHATWOOT_API_KEY = os.getenv("CHATWOOT_API_KEY")
CHATWOOT_ACCOUNT_ID = os.getenv("CHATWOOT_ACCOUNT_ID")
CHATWOOT_INBOX_ID = os.getenv("CHATWOOT_INBOX_ID")

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

    payload = {
        "inbox_id": int(CHATWOOT_INBOX_ID),
        "source_id": phone,
        "contact": {
            "name": contact_name,
            "phone_number": phone
        },
        "content": message_text
    }

    headers = {
        "Content-Type": "application/json",
        "api_access_token": yxKGn4IO24k4MRONILaJxG7xAK
    }

    chatwoot_url = f"https://app.chatwoot.com/api/v1/accounts/{CHATWOOT_ACCOUNT_ID}/conversations/incoming_messages"
    response = requests.post(chatwoot_url, json=payload, headers=headers)
    print("✅ Enviado a Chatwoot:", response.status_code, response.text)

    return "ok", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3000)
