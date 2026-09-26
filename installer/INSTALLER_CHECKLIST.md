# Checklist de Instalador VYNTRA

Antes de entregar un instalador a un cliente:

- [ ] `config.ini` apunta al dominio correcto del backend.
- [ ] `EvidenceBackend.Enabled = true`.
- [ ] `EvidenceBackend.DeviceToken` es unico por PC (o vacio para enrolamiento automatico; queda cifrado con DPAPI como `DeviceTokenProtected`).
- [ ] Build de produccion generado con `-Release -CertificateThumbprint ...` (falla si falta el certificado).
- [ ] `Update.SignerThumbprint` configurado con la huella del certificado de firma (o documentado por que no).
- [ ] No existe `config.ini` dentro de `dist\VYNTRAAgent` antes de empaquetar (el paquete genera el suyo).
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
