@echo off
chcp 65001 >nul
title JARVIS - Instalacao
cd /d "%~dp0"
echo.
echo  ==============================================
echo      J.A.R.V.I.S.  -  Instalacao
echo  ==============================================
echo.

rem ---------------------------------------------------------------- 1. Node.js
echo  [1/4] Verificando o Node.js...
where node >nul 2>nul
if errorlevel 1 goto sem_node
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 20 goto node_velho
for /f "delims=" %%v in ('node -v') do echo        OK - Node.js %%v
goto claude

:sem_node
echo        Node.js nao encontrado. Tentando instalar automaticamente...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto node_manual
echo.
echo        Node.js instalado.
echo        FECHE esta janela e de dois cliques em INSTALAR.bat de novo.
echo.
pause
exit /b 0

:node_velho
echo        O seu Node.js e antigo - precisa ser a versao 20 ou mais nova.
:node_manual
echo        Vou abrir o site do Node.js: baixe a versao LTS, instale,
echo        e depois de dois cliques em INSTALAR.bat de novo.
start "" https://nodejs.org/pt
echo.
pause
exit /b 1

rem ---------------------------------------------------------------- 2. Claude Code
:claude
echo.
echo  [2/4] Verificando o Claude Code...
where claude >nul 2>nul
if not errorlevel 1 goto claude_ok
echo        Claude Code nao encontrado. Instalando...
call npm install -g @anthropic-ai/claude-code
if errorlevel 1 goto erro_claude
:claude_ok
echo        OK - Claude Code instalado

rem ---------------------------------------------------------------- 3. Dependencias
echo.
echo  [3/4] Baixando os componentes do JARVIS - pode levar alguns minutos...
call npm install --no-audit --no-fund
if errorlevel 1 goto erro_npm
echo        OK - componentes instalados

rem ---------------------------------------------------------------- 4. Login
echo.
echo  [4/4] Verificando o login na sua conta Claude...
if exist "%USERPROFILE%\.claude\.credentials.json" goto logado
echo.
echo        Agora o Claude Code vai abrir para voce entrar na sua conta Claude.
echo        - Escolha o login com a sua assinatura Claude - Pro ou Max.
echo        - Vai abrir o navegador: confirme o acesso.
echo        - Quando o login terminar, digite  /exit  e aperte Enter.
echo.
pause
call claude
goto fim

:logado
echo        OK - voce ja esta logado

:fim
echo.
echo  ==============================================
echo      Instalacao concluida.
echo      Agora de dois cliques em INICIAR.bat
echo  ==============================================
echo.
pause
exit /b 0

:erro_claude
echo.
echo  ERRO: nao foi possivel instalar o Claude Code.
echo  Verifique a internet e tente de novo. Se continuar, instale pelo site:
echo  https://docs.claude.com/en/docs/claude-code
pause
exit /b 1

:erro_npm
echo.
echo  ERRO: a instalacao dos componentes falhou.
echo  Verifique a internet e o espaco livre no disco, e rode INSTALAR.bat de novo.
pause
exit /b 1
