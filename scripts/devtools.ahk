; Focus window
WinActivate "ahk_pid process.env.PROCESS_ID"

; Focus console
Click 28, 344
Sleep 100
Click 28, 344

; Connect
Send "nui_devtools{Enter}"
