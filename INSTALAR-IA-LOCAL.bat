@echo off
chcp 65001 >nul
title JARVIS - IA local (Ollama)
cd /d "%~dp0"
echo.
echo  ==============================================
echo      J.A.R.V.I.S.  -  IA local, sem gastar o Claude
echo  ==============================================
echo.
echo  Isto instala o Ollama e baixa um modelo de IA de uns 2 GB.
echo  Depois disso o JARVIS responde conversa e perguntas gerais
echo  aqui no seu PC, de graca e sem internet. Internet, acoes e
echo  tarefas dificeis continuam com o Claude.
echo.
echo  Precisa de uns 3 GB livres no disco. Espaco livre agora:
powershell -NoProfile -Command "Get-PSDrive C | ForEach-Object { '  {0:N1} GB livres' -f ($_.Free/1GB) }"
echo.
pause

where ollama >nul 2>nul
if not errorlevel 1 goto modelo
echo  [1/2] Instalando o Ollama...
winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto manual
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"

:modelo
echo.
echo  [2/2] Baixando o modelo qwen2.5:3b - pode levar alguns minutos...
ollama pull qwen2.5:3b
if errorlevel 1 goto erro
echo.
echo  ==============================================
echo      Pronto. A IA local ja esta ligada.
echo      Reinicie o JARVIS: botao direito no icone e
echo      "Reiniciar JARVIS".
echo  ==============================================
pause
exit /b 0

:manual
echo  Nao consegui instalar sozinho. Vou abrir o site do Ollama:
echo  baixe, instale e rode este arquivo de novo.
start "" https://ollama.com/download/windows
pause
exit /b 1

:erro
echo  ERRO ao baixar o modelo. Verifique a internet e o espaco no disco.
pause
exit /b 1
