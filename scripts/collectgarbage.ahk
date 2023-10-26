; Focus window (CefBrowserWindow is always the class of the NUI devtools)
WinActivate "ahk_class CefBrowserWindow ahk_pid process.env.PROCESS_ID"

; Click "Performance" tab
Click 360, 10

; Click garbage can icon (start garbage collection)
Click 592, 37
