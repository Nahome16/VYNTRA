# VYNTRA Database Schema

Esquema base para plataforma web + agente instalable.

## Nucleo multiempresa

- `companies`: empresas cliente.
- `departments`: departamentos por empresa.
- `roles`: roles internos del panel web.
- `users`: usuarios del panel web, como admin, RRHH, supervisor.
- `employees`: empleados monitoreados o gestionados.
- `devices`: PCs/agentes instalados, autenticados con token unico.

## Jornada laboral

- `shifts`: resumen diario de jornada por empleado/equipo.
- `shift_events`: eventos crudos de jornada, break, lunch, restauraciones, etc.

## Evidencias

- `evidence_files`: imagenes recibidas desde el agente.
- `evidence_upload_attempts`: auditoria de intentos aceptados, rechazados o duplicados.

## Incidencias y horas extra

- `incidents`: permisos, vacaciones, correcciones, fallas del sistema.
- `overtime_authorizations`: codigos de un solo uso para horas extra.

## Auditoria

- `audit_logs`: acciones sensibles del panel web o agente.

## Notas para produccion

- Hoy se usa `Base.metadata.create_all` para avanzar rapido.
- Antes de produccion formal conviene agregar Alembic para migraciones.
- `password_hash` queda reservado para autenticacion web.
- Las URLs publicas de evidencia no deben guardarse permanentes; el panel debe servir enlaces temporales o pasar por backend.
