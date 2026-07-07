@echo off
REM Start the Restaurant City local RPC/asset server + dashboard.
cd /d "%~dp0"
echo Starting Restaurant City local server on http://localhost:8090 ...
echo Dashboard: http://localhost:8090/__dash
echo.
npm start
