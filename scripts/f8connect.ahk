; Wait for window to exist
while (!WinExist("ahk_pid process.env.PROCESS_ID"))
{
	Sleep 0
}

; Focus window
WinActivate "ahk_pid process.env.PROCESS_ID"

; Open console
Send "{F8}"

; Focus console
Click 28, 344
Sleep 1000
Click 28, 344

; Connect
Send "connect process.env.SERVER_IP{Enter}"
