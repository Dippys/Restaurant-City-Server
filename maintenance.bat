@echo off
setlocal
title Restaurant City Reborn - Maintenance Mode
pushd "%~dp0"
node scripts\maintenance-server.cjs
set "RC_MAINTENANCE_EXIT=%ERRORLEVEL%"
popd
if not "%RC_MAINTENANCE_EXIT%"=="0" pause
exit /b %RC_MAINTENANCE_EXIT%
