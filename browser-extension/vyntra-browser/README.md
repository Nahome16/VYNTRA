# VYNTRA Browser

Extension requerida para Chrome o Edge que complementa la estacion web de marcaje.

## Que agrega

- Detecta cuando `https://vyntralab.tech/estacion` tiene sesion activa y consentimiento aceptado.
- Registra la pestana activa del navegador: dominio, URL, titulo, foco e idle.
- Envia muestras al endpoint existente `/api/agent/events` usando el token de la estacion web.
- Mantiene una cola local si no hay conexion.
- Permite capturar manualmente la pestana activa desde el popup y subirla como evidencia.
- La estacion web exige que esta extension este conectada antes de iniciar, pausar, reabrir o finalizar jornada.

## Limites

- No ve procesos ni aplicaciones fuera del navegador.
- No captura el escritorio completo de forma silenciosa.
- No funciona si Chrome o Edge estan cerrados.
- No accede a archivos personales; solo a informacion del navegador autorizada por permisos de extension.

## Instalacion local para pruebas

1. Abre `chrome://extensions` o `edge://extensions`.
2. Activa `Developer mode`.
3. Usa `Load unpacked`.
4. Selecciona esta carpeta: `browser-extension/vyntra-browser`.
5. Abre `https://vyntralab.tech/estacion`, inicia sesion y acepta el consentimiento.
6. Abre el popup de la extension y confirma que diga `Conectada a estacion`.

## Publicacion

Para distribuirla a empleados, empaqueta esta carpeta y publicala en Chrome Web Store, Microsoft Edge Add-ons o distribuyela por politica administrada de empresa.
