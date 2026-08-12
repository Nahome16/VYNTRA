# VYNTRA - Agente de escritorio

Agente local de marcaje, capturas y telemetria cruda con consentimiento explicito.

## Que hace el agente

- Solicita consentimiento al usuario la primera vez.
- Valida el login del empleado contra el backend cuando esta configurado.
- Permite iniciar jornada, break, lunch y finalizar jornada.
- Guarda bitacora local de la jornada.
- Toma capturas durante jornada activa.
- Registra telemetria cruda: proceso activo, titulo de ventana, inactividad, clics y cambios de ventana.
- Guarda eventos pendientes en `%LOCALAPPDATA%\VYNTRA\outbox.jsonl`.
- Restaura una jornada activa si la app se cierra y vuelve a abrir.

## Que NO hace

- No clasifica aplicaciones como productivas o no productivas.
- No trae listas locales de clasificacion dentro del instalador.
- No captura contrasenas ni contenido escrito con teclado.
- No activa camara ni microfono.

## Clasificacion de productividad

La clasificacion debe vivir en la plataforma web administrativa.

Flujo recomendado:

1. El agente sube datos crudos al backend.
2. La base de datos guarda procesos, titulos de ventana, timestamps, tiempo activo, tiempo idle y empleado/equipo.
3. El administrador define reglas por empresa, departamento o rol desde la plataforma web.
4. El backend aplica esas reglas para calcular productivo, no productivo o neutral.
5. Los dashboards muestran reportes a jefes, gerencia o RR. HH.

## Probar en desarrollo

```powershell
py -3.13 agent.py
```

Tambien puedes usar:

```text
run_agent.bat
```

Para reiniciar consentimiento:

```text
reset_consent.bat
```

## Empaquetar

```powershell
py -3.13 -m pip install pyinstaller
py -3.13 -m PyInstaller vyntra_agent.spec --clean
```

El resultado esperado es `dist\VYNTRAAgent\`.
