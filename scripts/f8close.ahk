; Wait for window to exist
while (!WinExist("ahk_pid process.env.PROCESS_ID"))
{
	Sleep 0
}

; Focus window
WinActivate "ahk_pid process.env.PROCESS_ID"

; Close console
Send "{F8}"
