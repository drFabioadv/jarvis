@echo off
chcp 65001 >nul
title JARVIS - usar no celular (Tailscale, gratis)
cd /d "%~dp0"
echo.
echo  Isto deixa o JARVIS do seu PC acessivel no seu celular, de
echo  qualquer lugar, pelo Tailscale (gratis). So funciona com o PC
echo  ligado. Nada fica aberto na internet: so os seus aparelhos.
echo.
echo  Antes: instale o Tailscale no PC e no iPhone (App Store) e
echo  entre com a MESMA conta nos dois.
echo.
pause
where tailscale >nul 2>nul || (echo  Instale o Tailscale: https://tailscale.com/download & pause & exit /b 1)
tailscale serve --bg 8090
if errorlevel 1 (echo  Ative o HTTPS no painel do Tailscale ^(DNS - HTTPS Certificates^) e rode de novo. & pause & exit /b 1)
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')"`) do set NOME=%%a
node -e "const p=require('path'),fs=require('fs');const f=p.join(process.env.LOCALAPPDATA,'JARVIS','pc','config.json');const c=JSON.parse(fs.readFileSync(f,'utf8'));c.enderecoTailscale='https://%NOME%';fs.writeFileSync(f,JSON.stringify(c,null,2))"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*cloud\src\pc.mjs*' } | % { Stop-Process -Id $_.ProcessId -Force }"
start "" wscript.exe "%~dp0app\cerebro-pc.vbs"
echo.
echo  ======================================================
echo   No iPhone, abra no Safari:   https://%NOME%
echo   Entre com a sua conta e toque em Compartilhar -
echo   "Adicionar a Tela de Inicio". Pronto: o JARVIS vira app.
echo  ======================================================
pause
