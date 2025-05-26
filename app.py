from flask import Flask, request
import requests

app = Flask(__name__)

@app.route("/", methods=["GET"])
def home():
    return "Servidor Flask activo"

@app.route("/", methods=["POST"])
def webhook():
    data = request.get_json()
    print("Mensaje recibido:", data)

    mensajes = data["entry"][0]["changes"][0]["value"].get("messages")
    if mensajes:
        mensaje = mensajes[0]
        texto = mensaje["text"]["body"]
        numero = mensaje["from"]

        payload = {
            "content": texto,
            "inbox_id": TU_INBOX_ID,
            "source_id": numero,
        }

        headers = {
            "api_access_token": "TU_CHATWOOT_TOKEN"
        }

        requests.post("https://app.chatwoot.com/api/v1/accounts/TU_ACCOUNT_ID/conversations", 
                      json=payload, headers=headers)

    return "ok", 200
