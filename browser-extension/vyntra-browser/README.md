# VYNTRA Browser

Extension requerida para Chrome o Edge que complementa la estacion web de marcaje.

## Que agrega

- Detecta cuando `https://vyntralab.tech/estacion` tiene sesion activa y consentimiento aceptado.
- Registra el foco y la inactividad de la pestana activa del navegador donde la extension esta instalada.
- Aplica la politica de captura minima: descarga las reglas de productividad de la empresa (`/api/agent/rules`) y, antes de enviar cualquier dato, sustituye la URL y el titulo de la pestana por un identificador normalizado. Si el sitio esta en una regla, el identificador es el patron de la regla (por ejemplo `salesforce.com`); si no, se envia `(sitio fuera de lista)`. La URL, el dominio y el titulo literales nunca se guardan ni se transmiten.
- Cuenta clics y cambios de foco en pestanas web de ese navegador durante la jornada activa.
- Mantiene el conteo de tiempo y actividad del navegador mientras la jornada siga activa, incluso si el usuario cierra la pestana de la estacion.
- Envia muestras al endpoint existente `/api/agent/events` usando el token de la estacion web.
- Mantiene una cola local si no hay conexion.
- Permite capturar manualmente la pestana activa desde el popup y subirla como evidencia.
- Captura automaticamente la pestana visible cada 5 minutos mientras la jornada esta en estado trabajando, con sesion y consentimiento activos.
- Solo captura evidencia cuando la pestana activa es un sitio clasificado como productivo por las reglas de la empresa. En cualquier otro sitio la captura se omite.
- La estacion web exige version compatible de esta extension antes de iniciar, pausar, reabrir o finalizar jornada.

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
- La captura automatica requiere permiso de acceso a pestanas del navegador para que Chrome/Edge permita capturar la pestana activa sin una accion manual en cada captura.

## Instalacion local para pruebas

1. Abre `chrome://extensions` o `edge://extensions`.
2. Activa `Developer mode`.
3. Usa `Load unpacked`.
4. Selecciona esta carpeta: `browser-extension/vyntra-browser`.
5. Abre `https://vyntralab.tech/estacion`, inicia sesion y acepta el consentimiento.
6. Abre el popup de la extension y confirma que diga `Conectada a estacion`.

## Publicacion

Para distribuirla a empleados, empaqueta esta carpeta y publicala en Chrome Web Store, Microsoft Edge Add-ons o distribuyela por politica administrada de empresa.
