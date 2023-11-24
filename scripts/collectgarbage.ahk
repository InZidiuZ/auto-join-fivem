; Exit script if window does not exist (CefBrowserWindow is always the class of the NUI devtools)
if (!WinExist("ahk_class CefBrowserWindow ahk_pid process.env.PROCESS_ID"))
{
	return
}

; Activate the window
WinActivate

; Click "Performance" tab
Click 360, 10

; Click garbage can icon (start garbage collection)
Click 592, 37
