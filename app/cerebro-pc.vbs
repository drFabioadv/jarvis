' Liga o cérebro do JARVIS no PC (plataforma + modelo local), sem janela.
Set fso = CreateObject("Scripting.FileSystemObject")
raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists(raiz & "\logs") Then fso.CreateFolder(raiz & "\logs")
Set s = CreateObject("WScript.Shell")
s.CurrentDirectory = raiz
s.Run "cmd /c node cloud\src\pc.mjs >> logs\cerebro-pc.log 2>&1", 0, False
