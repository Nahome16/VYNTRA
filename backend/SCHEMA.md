# VYNTRA Database Schema

Esquema base para plataforma web + agente instalable.

## Nucleo multiempresa

- `companies`: empresas cliente.
- `departments`: departamentos por empresa.
- `roles`: roles internos del panel web.
- `users`: usuarios del panel web, como admin, RRHH, supervisor.
- `employees`: empleados monitoreados o gestionados.
- `employee_credentials`: credenciales de acceso a la estacion de marcaje, asociadas a `employees`.
- `positions`: puestos laborales de empleados; separado de `roles`, que solo controla acceso al panel.
- `devices`: PCs/agentes instalados, autenticados con token unico.
- `company_settings`: parametros configurables por empresa.

## Jornada laboral

- `shifts`: resumen diario de jornada por empleado/equipo.
- `shift_events`: eventos crudos de jornada, break, lunch, restauraciones, etc.

## Evidencias

- `evidence_files`: imagenes recibidas desde el agente.
- `evidence_upload_attempts`: auditoria de intentos aceptados, rechazados o duplicados.

## Actividad de aplicaciones

- `activities`: muestras crudas de aplicacion/ventana activa capturadas por el agente.
- `app_catalog`: catalogo normalizado de ejecutables por empresa.
- `window_title_catalog`: catalogo normalizado de titulos de ventana por empresa.
- `productivity_rules`: reglas por empresa/departamento/puesto/empleado para clasificar apps o titulos como productivos, no productivos o neutrales.
- `productivity_blocks`: bloques agregados para reporteria y dashboards.
- `etl_run_logs`: historial de ejecuciones del proceso de agregacion.

## Incidencias y horas extra

- `incidents`: permisos, vacaciones, correcciones, fallas del sistema.
- `overtime_authorizations`: codigos de un solo uso para horas extra.

## Auditoria

- `audit_logs`: acciones sensibles del panel web o agente.
- `consent_records`: consentimientos aceptados o rechazados por empleado/credencial/dispositivo.
- `station_login_events`: historial de accesos a la estacion de marcaje.

## Seguridad de acceso

- `login_attempts`: historial de intentos de login.
- `login_lockouts`: bloqueos activos por IP y correo.

## Sincronizacion del agente

- `POST /api/evidence/upload`: recibe capturas.
- `POST /api/agent/events`: recibe eventos pendientes del outbox local y llena `shifts`, `shift_events` y `activities`.

## Notas para produccion

- Hoy se usa `Base.metadata.create_all` para avanzar rapido.
- Antes de produccion formal conviene agregar Alembic para migraciones.
- `password_hash` queda reservado para autenticacion web.
- Las URLs publicas de evidencia no deben guardarse permanentes; el panel debe servir enlaces temporales o pasar por backend.
