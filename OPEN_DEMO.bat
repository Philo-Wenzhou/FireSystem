@echo off
cd /d "%~dp0"
start "Fire Demo Server" cmd /k python -m http.server 8000
start "" http://localhost:8000
