@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\JARVIS-agente.lnk" 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*jarvis-agente.mjs*' } | % { Stop-Process -Id $_.ProcessId -Force }"
echo O agente nao inicia mais com o Windows. Para revogar o acesso, remova o computador em Configuracoes do JARVIS.
pause
