; Exit script if window does not exist (CefBrowserWindow is always the class of the NUI devtools)
if (!WinExist("NUI DevTools ahk_exe process.env.PROCESS_NAME"))
{
	return
}

; Activate the window
WinActivate

; Click "Performance" tab
Click 360, 10

; Click garbage can icon (start garbage collection)
Click 592, 37
