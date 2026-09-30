@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =======================================================
echo   KHỞI ĐỘNG VECTOR BROWSER AI (DASHBOARD + BACKEND)
echo =======================================================
echo Dashboard: http://localhost:5174
echo Backend:   http://localhost:3220
echo.
npm run dev
