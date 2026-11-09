@echo off
chcp 65001 >nul
title Laagab server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed - https://nodejs.org & pause & exit /b 1)
:loop
node server.js
echo Server stopped - restarting in 3 s (close this window to stop)
timeout /t 3 >nul
goto loop
