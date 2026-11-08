@echo off
chcp 65001 >nul
title J.A.R.V.I.S.
cd /d "%~dp0"

if not exist "node_modules\" (
  echo Primeira vez: vou instalar antes de iniciar...
  call "%~dp0INSTALAR.bat"
)

rem Chave da ElevenLabs - opcional. Cole a chave na primeira linha de elevenlabs.txt
if exist "elevenlabs.txt" set /p ELEVENLABS_API_KEY=<"elevenlabs.txt"
rem ID de uma voz da ElevenLabs - opcional. Cole na primeira linha de elevenlabs-voz.txt
if exist "elevenlabs-voz.txt" set /p JARVIS_VOICE_ID=<"elevenlabs-voz.txt"

rem Procura o Chrome; se nao achar, usa o Edge; se nao achar, o navegador padrao.
set "NAVEGADOR="
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "NAVEGADOR=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "NAVEGADOR=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "NAVEGADOR=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined NAVEGADOR if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "NAVEGADOR=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

rem Abre o navegador sozinho depois de alguns segundos, quando o servidor ja subiu.
if defined NAVEGADOR (
  start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 9; Start-Process -FilePath '%NAVEGADOR%' -ArgumentList 'http://localhost:5173'"
) else (
  start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 9; Start-Process 'http://localhost:5173'"
)

echo.
echo  ==============================================
echo      J.A.R.V.I.S. ligando...
echo      O navegador vai abrir sozinho em alguns segundos.
echo      Clique em INICIALIZAR e diga "Ei Jarvis".
echo.
echo      NAO feche esta janela enquanto usar o JARVIS.
echo      Para desligar, feche esta janela.
echo  ==============================================
echo.

if /i "%~1"=="acao" (
  call npm start -- --writes
) else (
  call npm start
)
pause
