@echo off
chcp 65001 >nul
title JARVIS 3.0 - Agente local
cd /d "%~dp0"
where node >nul 2>nul || (echo Instale o Node.js 22 ou mais novo: https://nodejs.org & pause & exit /b 1)
call npm install --omit=dev
echo.
set /p URL=Endereco do seu JARVIS (ex.: https://jarvis.seudominio.com.br): 
set /p COD=Codigo de pareamento (Configuracoes ^> Computadores ^> Gerar codigo): 
node jarvis-agente.mjs parear %URL% %COD%
if errorlevel 1 (pause & exit /b 1)
echo Criando atalho para iniciar com o Windows...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\JARVIS-agente.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0iniciar-oculto.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
start "" wscript.exe "%~dp0iniciar-oculto.vbs"
echo Pronto. O agente liga sozinho com o Windows.
pause
