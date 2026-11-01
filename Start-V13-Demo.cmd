@echo off
cd /d "%~dp0"
set HH_APP_VERSION=v13
python -X utf8 preview.py --port 8766
pause
