@echo off
chcp 65001 >nul
title JARVIS - Atalho do iPhone
cd /d "%~dp0"
echo.
echo  ==============================================
echo      J.A.R.V.I.S.  -  Atalho do iPhone
echo  ==============================================
echo.
echo  O Tailscale cria uma conexao privada e gratuita entre o seu
echo  iPhone e este PC. So os seus aparelhos enxergam o JARVIS.
echo.
where tailscale >nul 2>nul
if not errorlevel 1 goto logado
echo  [1/3] Instalando o Tailscale...
winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%ProgramFiles%\Tailscale"
:logado
echo.
echo  [2/3] Entre na sua conta do Tailscale - pode ser a do Google.
echo        Se abrir o navegador, faca o login e volte aqui.
tailscale up
echo.
echo  [3/3] Liberando o JARVIS so para os seus aparelhos...
echo        Se aparecer um link pedindo para ativar HTTPS, abra, ative e
echo        rode este arquivo de novo.
tailscale serve --bg 8787
echo.
echo  ==============================================
echo   Anote o endereco que comeca com https:// abaixo:
echo  ==============================================
tailscale serve status
echo.
echo  A senha do atalho esta no arquivo atalho-token.txt desta pasta.
echo  O passo a passo do iPhone esta no GUIA-JARVIS.pdf.
start "" notepad.exe "%~dp0atalho-token.txt"
pause
