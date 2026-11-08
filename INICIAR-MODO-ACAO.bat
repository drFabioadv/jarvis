@echo off
chcp 65001 >nul
title J.A.R.V.I.S. - MODO ACAO
cd /d "%~dp0"
echo.
echo  ATENCAO - MODO ACAO
echo.
echo  Neste modo o JARVIS pode AGIR no seu computador: clicar e digitar
echo  no Chrome, rodar comandos, criar e apagar arquivos.
echo  Um pedido mal entendido pode ter efeito real.
echo.
echo  No modo normal - INICIAR.bat - ele so pesquisa, mostra e responde.
echo.
choice /c SN /m "  Quer mesmo iniciar no modo acao"
if errorlevel 2 exit /b 0
call "%~dp0INICIAR.bat" acao
