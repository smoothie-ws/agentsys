@echo off
cd /d "%~dp0"
if not "%~1"=="" set "AGENTSYS_PORT=%~1"
if not defined AGENTSYS_PORT set "AGENTSYS_PORT=8080"
if not defined AGENTSYS_CLIENT_PORT set "AGENTSYS_CLIENT_PORT=8081"
start "" "http://127.0.0.1:%AGENTSYS_CLIENT_PORT%/"
node bin/agentsys-local.js
