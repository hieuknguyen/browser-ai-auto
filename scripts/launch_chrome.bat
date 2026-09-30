@echo off
set "CHROME_BIN=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_BIN%" set "CHROME_BIN=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_BIN%" set "CHROME_BIN=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_BIN%" if defined ProgramW6432 set "CHROME_BIN=%ProgramW6432%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME_BIN%" (
    for /f "tokens=*" %%i in ('where chrome.exe 2^>nul') do (
        set "CHROME_BIN=%%i"
        goto :found
    )
)
:found
start "" "%CHROME_BIN%" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.browser-ai-auto\chrome_profile" --no-first-run --no-default-browser-check --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-infobars --start-maximized about:blank
