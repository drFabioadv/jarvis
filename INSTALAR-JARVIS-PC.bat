@echo off
chcp 65001 >nul
title JARVIS - cérebro no seu PC (grátis, sem Claude)
cd /d "%~dp0"
echo.
echo  ======================================================
echo      J.A.R.V.I.S.  -  tudo no seu PC, sem custo
echo  ======================================================
echo.
echo  Isto instala o cérebro do JARVIS no seu computador:
echo   - Ollama + modelo Qwen 2.5 de 14B (uns 9 GB, roda na placa de video)
echo   - modelo de memoria bge-m3 (uns 1,2 GB)
echo   - a plataforma JARVIS (memoria, agentes, tarefas, rotinas, celular)
echo  Depois disso o JARVIS deixa de usar o Claude. Nada e pago.
echo.
echo  Precisa de uns 15 GB livres no disco. Espaco livre agora:
powershell -NoProfile -Command "Get-PSDrive C | ForEach-Object { '  {0:N1} GB livres' -f ($_.Free/1GB) }"
echo.
pause

where node >nul 2>nul || (echo  Rode primeiro o INSTALAR.bat ^(instala o Node.js^). & pause & exit /b 1)

where ollama >nul 2>nul
if not errorlevel 1 goto modelos
echo  [1/5] Instalando o Ollama...
winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
if errorlevel 1 (echo  Nao consegui instalar. Baixe em https://ollama.com/download e rode este arquivo de novo. & pause & exit /b 1)
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"
start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
timeout /t 5 >nul

:modelos
echo.
echo  [2/5] Baixando o modelo principal (qwen2.5:14b). Pode demorar bastante...
ollama pull qwen2.5:14b
if errorlevel 1 goto erro
echo  [2/5] Baixando o modelo de memoria (bge-m3)...
ollama pull bge-m3
if errorlevel 1 goto erro

echo.
echo  [3/5] Instalando a plataforma...
pushd cloud
call npm install --no-audit --no-fund
if errorlevel 1 (popd & goto erro)
popd
echo  [4/5] Preparando a interface (computador e celular)...
call npx vite build --mode cloud
if errorlevel 1 goto erro

echo  [5/5] Ligando o cerebro do PC e iniciando com o Windows...
node -e "const f='jarvis-config.json';const fs=require('fs');const c=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};c.cerebro='pc';fs.writeFileSync(f,JSON.stringify(c,null,2))"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\JARVIS-cerebro-PC.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0app\cerebro-pc.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
start "" wscript.exe "%~dp0app\cerebro-pc.vbs"
echo  Aguardando o cerebro ligar...
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try { if((Invoke-WebRequest -UseBasicParsing http://localhost:8090/api/saude -TimeoutSec 2).StatusCode -eq 200){ exit 0 } } catch {}; Start-Sleep 1 }; exit 1"
if errorlevel 1 (echo  O cerebro demorou a ligar. Veja logs\cerebro-pc.log. & pause & exit /b 1)

echo.
echo  ======================================================
echo      Pronto! Agora:
echo      1. Vai abrir http://localhost:8090 - crie a sua conta
echo         com o codigo abaixo e ative o autenticador.
echo      2. Reinicie o JARVIS da bandeja (botao direito no
echo         icone - Reiniciar JARVIS): ele passa a usar o
echo         cerebro do PC em vez do Claude.
echo      3. Para usar no celular: CONFIGURAR-CELULAR.bat
echo  ======================================================
echo.
type "%LOCALAPPDATA%\JARVIS\pc\codigo-de-cadastro.txt" 2>nul
start "" http://localhost:8090
pause
exit /b 0

:erro
echo.
echo  Algo deu errado. Tire um print desta janela e mande para o Claude.
pause
exit /b 1
