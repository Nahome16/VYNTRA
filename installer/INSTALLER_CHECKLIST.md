# Checklist de Instalador VYNTRA

Antes de entregar un instalador a un cliente:

- [ ] `config.ini` apunta al dominio correcto del backend.
- [ ] `EvidenceBackend.Enabled = true`.
- [ ] `EvidenceBackend.DeviceToken` es unico por PC.
- [ ] `GoogleDrive.Enabled = false`.
- [ ] No existe `credentials.json` dentro de `dist\VYNTRAAgent`.
- [ ] No existe `token.json` dentro de `dist\VYNTRAAgent`.
- [ ] El backend responde `GET /health`.
- [ ] Se ejecuto `.\installer\install_agent_autostart.ps1` en la PC destino.
- [ ] Existe la tarea programada `VYNTRA Agent`.
- [ ] La tarea programada inicia al abrir sesion del usuario.
- [ ] La tarea programada reintenta si el agente falla.
- [ ] La PC de prueba puede subir una captura.
- [ ] La evidencia aparece registrada en PostgreSQL.
- [ ] La imagen queda guardada en el storage del backend.
- [ ] Se probo desconectar internet y verificar que queda pendiente en SQLite.
- [ ] Se reinicio la PC de prueba y el agente abrio sin ejecutar `run_agent.bat`.
