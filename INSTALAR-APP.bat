@echo off
chcp 65001 >nul
title JARVIS - Instalar o app
cd /d "%~dp0"
echo.
echo  ==============================================
echo      J.A.R.V.I.S.  -  Instalar o app
echo  ==============================================
echo.
if not exist "node_modules\" (
  echo  Primeiro, a instalacao basica...
  call "%~dp0INSTALAR.bat"
)
if not exist "node_modules\" (
  echo  A instalacao basica nao terminou. Rode INSTALAR.bat e tente de novo.
  pause
  exit /b 1
)

echo  Desligando uma versao antiga do app, se estiver aberta...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*JARVIS-bandeja.ps1*' -or $_.CommandLine -like '*scripts\app.mjs*' -or $_.CommandLine -like '*JARVIS\perfil-*' -or $_.CommandLine -like '*scripts/start.mjs*' -or $_.CommandLine -like '*bridge/server.mjs*' -or $_.CommandLine -like '*vite.js*' -or $_.CommandLine -like '*scripts\app.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo  Criando os atalhos - Area de Trabalho, Menu Iniciar e Inicializacao do Windows...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\atalhos.ps1"
if errorlevel 1 goto erro

echo.
echo  ==============================================
echo      Pronto. O JARVIS agora:
echo       - liga sozinho quando o computador ligar;
echo       - fica no icone perto do relogio - setinha ^^;
echo       - continua ouvindo mesmo com a janela fechada;
echo       - para desligar de verdade: botao direito no
echo         icone e "Sair".
echo.
echo      Abrindo o JARVIS agora...
echo  ==============================================
start "" wscript.exe "%~dp0app\JARVIS.vbs"
echo.
pause
exit /b 0

:erro
echo.
echo  ERRO ao criar os atalhos. Tire uma foto desta tela e mande para o suporte.
pause
exit /b 1
