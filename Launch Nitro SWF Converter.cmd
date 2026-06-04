@echo off
setlocal
cd /d "%~dp0"
node "%~dp0src\NitroSwfConverter.js"
echo.
pause
