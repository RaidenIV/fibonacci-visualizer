@echo off
setlocal
cd /d "%~dp0"
start "" http://localhost:8080
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8080
) else (
  python -m http.server 8080
)
