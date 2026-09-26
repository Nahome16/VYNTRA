@echo off
setlocal
rem Herramienta de desarrollo/soporte: elimina SOLO los registros locales de
rem consentimiento (consent.json y consent_<hash>.json) para volver a mostrar el
rem aviso. No borra jornadas, outbox ni evidencias pendientes: las jornadas se
rem restauran tras cierres imprevistos y borrarlas perderia tiempo registrado.
set "BASE=%LOCALAPPDATA%\VYNTRA"

echo Se eliminaran los registros de consentimiento locales en "%BASE%".
set /p "CONFIRM=Escribe SI para continuar: "
if /I not "%CONFIRM%"=="SI" (
    echo Cancelado.
    pause
    exit /b 1
)

if exist "%BASE%\consent.json" del "%BASE%\consent.json" 2>nul
for %%F in ("%BASE%\consent_*.json") do del "%%~fF" 2>nul

echo Consentimiento reiniciado. Las jornadas y eventos pendientes se conservaron.
pause
