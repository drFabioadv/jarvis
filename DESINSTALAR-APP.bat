@echo off
chcp 65001 >nul
title JARVIS - Remover o app
cd /d "%~dp0"
echo.
echo  Desligando o JARVIS e removendo os atalhos...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*JARVIS-bandeja.ps1*' -or $_.CommandLine -like '*scripts\app.mjs*' -or $_.CommandLine -like '*JARVIS\perfil-*' -or $_.CommandLine -like '*scripts/start.mjs*' -or $_.CommandLine -like '*bridge/server.mjs*' -or $_.CommandLine -like '*vite.js*' -or $_.CommandLine -like '*scripts\app.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\atalhos.ps1" -Remover
echo.
echo  Pronto. O JARVIS nao liga mais sozinho.
echo  A pasta do projeto continua aqui; o INICIAR.bat segue funcionando.
echo.
pause
