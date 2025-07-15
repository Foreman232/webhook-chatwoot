import streamlit as st
import pandas as pd
import requests

st.set_page_config(page_title="📨 Envío Masivo WhatsApp", layout="centered")
st.title("📨 Envío Masivo de WhatsApp con Plantillas")

if "ya_ejecuto" not in st.session_state:
    st.session_state["ya_ejecuto"] = False

api_key = st.text_input("🔐 Ingresa tu API Key de 360dialog", type="password")
file = st.file_uploader("📁 Sube tu archivo Excel", type=["xlsx"])

plantillas = {
    "mensaje_entre_semana_24_hrs": lambda localidad: f"""Buen día, te saludamos de CHEP (Tarimas azules), es un gusto en saludarte.

Te escribo para confirmar que el día de mañana tenemos programada la recolección de tarimas en tu localidad: {localidad}.

¿Me podrías indicar cuántas tarimas tienes para entregar? Así podremos coordinar la unidad.""",

    "recordatorio_24_hrs": lambda: "Buen día, estamos siguiendo tu solicitud, ¿Me ayudarías a confirmar si puedo validar la cantidad de tarimas que serán entregadas?"
}

def normalizar_numero(phone):
    if phone.startswith("+521"):
        return "+52" + phone[4:]
    return phone

if file:
    df = pd.read_excel(file)
    df.columns = df.columns.str.strip()
    st.success(f"Archivo cargado con {len(df)} registros.")
    columnas = df.columns.tolist()

    plantilla_col = st.selectbox("🧩 Columna plantilla:", columnas)
    telefono_col = st.selectbox("📱 Teléfono:", columnas)
    nombre_col = st.selectbox("📇 Nombre:", columnas)
    pais_col = st.selectbox("🌎 Código país:", columnas)
    param1_col = st.selectbox("🔢 Parámetro {{1}}:", ["(ninguno)"] + columnas)
    param2_col = st.selectbox("🔢 Parámetro {{2}} (opcional):", ["(ninguno)"] + columnas)

    if st.button("🚀 Enviar mensajes") and not st.session_state["ya_ejecuto"]:
        if not api_key:
            st.error("⚠️ Falta API Key.")
            st.stop()

        st.session_state["ya_ejecuto"] = True

        for idx, row in df.iterrows():
            raw_number = f"{str(row[pais_col])}{str(row[telefono_col])}".replace(" ", "").replace("-", "")
            chatwoot_number = f"+{raw_number}"
            whatsapp_number = normalizar_numero(chatwoot_number)
            nombre = str(row[nombre_col]).strip()

            if "enviado" in df.columns and row.get("enviado") == True:
                continue

            plantilla_nombre = str(row[plantilla_col]).strip()
            parameters = []
            param1 = ""
            param2 = ""

            if plantilla_nombre == "recordatorio_24_hrs":
                mensaje_real = plantillas["recordatorio_24_hrs"]()
                param1 = "Cliente WhatsApp"
            else:
                if param1_col != "(ninguno)":
                    param1 = str(row[param1_col])
                    parameters.append({"type": "text", "text": param1})
                if param2_col != "(ninguno)":
                    param2 = str(row[param2_col])
                    parameters.append({"type": "text", "text": param2})
                mensaje_real = plantillas.get(plantilla_nombre, lambda x: f"Mensaje enviado con parámetro: {x}")(param1)

            # Enviar mensaje por WhatsApp
            payload = {
                "messaging_product": "whatsapp",
                "to": whatsapp_number.replace("+", ""),
                "type": "template",
                "template": {
                    "name": plantilla_nombre,
                    "language": {"code": "es_MX"},
                    "components": []
                }
            }

            if parameters:
                payload["template"]["components"].append({
                    "type": "body",
                    "parameters": parameters
                })

            headers = {
                "Content-Type": "application/json",
                "D360-API-KEY": api_key
            }

            r = requests.post("https://waba-v2.360dialog.io/messages", headers=headers, json=payload)
            df.at[idx, "enviado"] = r.status_code == 200

            if r.status_code == 200:
                st.success(f"✅ WhatsApp enviado: {whatsapp_number}")

                # Reflejar en Chatwoot
                chatwoot_payload = {
                    "phone": chatwoot_number,
                    "name": nombre or "Cliente WhatsApp",
                    "content": mensaje_real
                }

                try:
                    cw = requests.post("https://webhook-chatwoots.onrender.com/send-chatwoot-message", json=chatwoot_payload)
                    if cw.status_code == 200:
                        st.info(f"📥 Reflejado en Chatwoot: {chatwoot_number}")
                    else:
                        st.warning(f"⚠️ Chatwoot error: {cw.text}")
                except Exception as e:
                    st.error(f"❌ Error Chatwoot: {e}")
            else:
                st.error(f"❌ WhatsApp error: {r.text}")
