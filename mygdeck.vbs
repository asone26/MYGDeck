' mygdeck launcher without a console window. Double-click this instead of mygdeck.bat.
' If the app is not built yet, falls back to mygdeck.bat so build progress is visible.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\src-tauri\target\release\mygdeck.exe"

args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next

If fso.FileExists(exe) Then
  sh.Run """" & exe & """" & args, 1, False
Else
  sh.Run """" & root & "\mygdeck.bat""" & args, 1, False
End If
