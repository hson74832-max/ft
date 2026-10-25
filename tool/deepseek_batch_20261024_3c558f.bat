@echo off
cd /d "%~dp0"

echo Starting Vite dev server...
start "Vite Dev Server" cmd /k "npm run dev"

REM Wait a few seconds for the server to initialize
timeout /t 3 /nobreak >nul

echo Opening browser...
start http://localhost:3002/

echo Done! The server is running in a new window.
pause