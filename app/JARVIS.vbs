' J.A.R.V.I.S. - abre o app da bandeja sem mostrar nenhuma janela preta.
' Argumentos repassados: -Oculto (comecar escondido) e -Acao (modo acao).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = pasta & "\JARVIS-bandeja.ps1"
extra = ""
For Each a In WScript.Arguments
  extra = extra & " " & a
Next
sh.CurrentDirectory = fso.GetParentFolderName(pasta)
sh.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & extra, 0, False
