# VYNTRA Browser

Extension requerida para Chrome o Edge que complementa la estacion web de marcaje. Version actual: **0.3.1**.

## Que agrega

- Detecta cuando `https://vyntralab.tech/estacion` tiene sesion activa y consentimiento aceptado.
- Registra el foco y la inactividad de la pestana activa del navegador donde la extension esta instalada.
- Aplica la politica de captura minima: descarga las reglas de productividad de la empresa (`/api/agent/rules`) y, antes de enviar cualquier dato, sustituye la URL y el titulo de la pestana por un identificador normalizado. Si el sitio esta en una regla, el identificador es el patron de la regla (por ejemplo `salesforce.com`); si no, se envia `(sitio fuera de lista)`. La URL, el dominio y el titulo literales nunca se guardan ni se transmiten.
- Coincidencia de reglas: los patrones con forma de dominio (con punto y sin espacios, como `salesforce.com` o `.salesforce.com`) solo coinciden con el host exacto o con un subdominio (`acme.my.salesforce.com`); nunca como subcadena (`evil-salesforce.com`) ni por aparecer en el titulo. Los demas patrones se comparan como subcadena sin distinguir mayusculas.
- Cuenta clics y cambios de foco en la estacion y en los sitios clasificados como productivos durante la jornada activa (ver "Permisos").
- Mantiene el conteo de tiempo y actividad del navegador mientras la jornada siga activa, incluso si el usuario cierra la pestana de la estacion (mientras el navegador siga abierto).
- Envia muestras al endpoint existente `/api/agent/events` usando el token de la estacion web, en lotes.
- Mantiene una cola local si no hay conexion. La cola se serializa (sin perdidas por escrituras concurrentes) y, si crece demasiado, descarta primero las muestras mas antiguas; los eventos de marcaje nunca se descartan.
- Permite capturar manualmente la pestana activa desde el popup y subirla como evidencia.
- Captura automaticamente la pestana visible cada 5 minutos mientras la jornada esta en estado trabajando, con sesion y consentimiento activos.
- Solo captura evidencia cuando la pestana activa es un sitio clasificado como productivo. Antes de subir, vuelve a consultar la pestana activa: si cambio durante la captura, la imagen se descarta.
- La estacion web exige version compatible de esta extension antes de iniciar, pausar, reabrir o finalizar jornada.

## Seguridad

- El token de la estacion se guarda en `chrome.storage.session` (memoria del navegador, inaccesible para content scripts); si el navegador no lo soporta, en `chrome.storage.local`. Tras reiniciar el navegador hay que volver a abrir la estacion web para reanudar el seguimiento.
- `apiBase` recibido en `station_sync` debe ser un origen permitido (`https://vyntralab.tech`, `https://www.vyntralab.tech`; `localhost` solo en el build de desarrollo) e igual al origen de la pagina que envia el mensaje.
- Los mensajes de la estacion solo se aceptan desde content scripts en esos origenes (se valida `sender.url`); las acciones del popup solo desde paginas de la propia extension.

## Permisos

- El content script estatico solo corre en los origenes de la estacion.
- Para contar clics en otros sitios, la extension registra un content script dinamico (`chrome.scripting.registerContentScripts`, permiso `scripting`) solo para los dominios de reglas productivas del navegador. Las reglas productivas que no son dominios (por ejemplo `Salesforce` como texto del titulo) no pueden traducirse a hosts: en esos sitios no se cuentan clics, aunque si se registra la actividad y la evidencia.
- `host_permissions: <all_urls>` se mantiene porque la captura automatica de la pestana visible (`captureVisibleTab`) y el registro dinamico lo requieren.
- `scripting` no muestra una advertencia nueva al actualizar, y ya no se incluyen origenes `localhost` en el manifest de produccion.

## Limites

- No ve procesos ni aplicaciones fuera del navegador.
- No captura el escritorio completo ni aplicaciones fuera del navegador.
- Si el empleado trabaja en otro navegador, tambien debe instalar la extension en ese navegador para registrar esa actividad.
- No captura durante break, lunch, fuera de jornada, jornada terminada o sin consentimiento activo.
- Para tomar break, lunch o finalizar jornada, el usuario debe volver a abrir la estacion web.
- No lee teclas, contrasenas ni texto escrito en formularios; solo registra contadores de actividad.
- No puede contar clics dentro de paginas internas del navegador como `chrome://`, la barra de direcciones o controles propios de Chrome/Edge.
- No funciona si Chrome o Edge estan cerrados.
- No accede a archivos personales; solo a informacion del navegador autorizada por permisos de extension.

## Instalacion local para pruebas

Produccion (`manifest.json`, solo `vyntralab.tech`):

1. Abre `chrome://extensions` o `edge://extensions`.
2. Activa `Developer mode`.
3. Usa `Load unpacked` y selecciona esta carpeta: `browser-extension/vyntra-browser`.
4. Abre `https://vyntralab.tech/estacion`, inicia sesion y acepta el consentimiento.
5. Abre el popup de la extension y confirma que diga `Conectada a estacion`.

Desarrollo contra `http://localhost:3000` / `:3001` (`manifest.dev.json`):

```bash
node browser-extension/vyntra-browser/scripts/build-dev.mjs
```

El script crea una copia en `<tmp>/vyntra-browser-dev` (o en la carpeta indicada como argumento) con `manifest.dev.json` como `manifest.json` (`version_name` `0.3.1-dev`). Carga esa carpeta con `Load unpacked`. No distribuyas el build de desarrollo.

## Pruebas

```bash
node --check browser-extension/vyntra-browser/background.js
node --test browser-extension/vyntra-browser/tests/normalize.test.mjs
```

## Publicacion

Para distribuirla a empleados, empaqueta esta carpeta y publicala en Chrome Web Store, Microsoft Edge Add-ons o distribuyela por politica administrada de empresa. El ZIP descargable (`web/public/extensions/vyntra-browser-extension.zip`) contiene en la raiz: `background.js`, `content-script.js`, `manifest.json`, `popup.css`, `popup.html`, `popup.js` y `README.md` (sin `manifest.dev.json`, `scripts/` ni `tests/`).
