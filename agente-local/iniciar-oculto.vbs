' Inicia o agente do JARVIS sem janela.
Set s = CreateObject("WScript.Shell")
s.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
s.Run "node jarvis-agente.mjs", 0, False
