@echo off
setlocal
set "BASE=%LOCALAPPDATA%\VYNTRA"
set "CONSENT=%BASE%\consent.json"
set "JORNADAS=%BASE%\jornadas"

if exist "%CONSENT%" del "%CONSENT%" 2>nul
if exist "%JORNADAS%" (
    for %%F in ("%JORNADAS%\jornada_*.json") do del "%%~fF" 2>nul
    if exist "%JORNADAS%\archivo" (
        for %%F in ("%JORNADAS%\archivo\jornada_*.json") do del "%%~fF" 2>nul
    )
)

echo Estado reiniciado: consentimiento y reloj de jornada eliminados si existian.
pause
