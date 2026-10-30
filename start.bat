@echo off
cd /d "%~dp0"
if not "%~1"=="" set "PORT=%~1"
if not defined PORT set "PORT=8080"
start "" "http://localhost:%PORT%/editor/"
node server.js --port "%PORT%"
