@echo off
chcp 65001 >nul
cd /d "%~dp0"
if "%~1"=="" (
    echo Cách dùng:
    echo   run-ai.bat "Yêu cầu của bạn" [URL_bắt_đầu]
    echo.
    echo Ví dụ:
    echo   run-ai.bat "tìm kiếm bài hát mới nhất của Sơn Tùng M-TP" https://www.youtube.com/
    echo   run-ai.bat "tìm kiếm thông tin thời tiết hôm nay" https://www.google.com/
    exit /b 1
)
.venv\Scripts\python.exe scripts\run_ai.py %*
