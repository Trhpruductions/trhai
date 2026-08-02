Option Explicit

Dim shell, fso, rootDir, launcherBat
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherBat = rootDir & "\Launch-AscendAI.bat"

shell.Run """" & launcherBat & """ __hidden__", 0, False
