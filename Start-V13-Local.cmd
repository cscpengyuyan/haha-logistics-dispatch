@echo off
cd /d "%~dp0"
set HH_APP_VERSION=v13
python -X utf8 server.py --demo --db data\v13-demo.sqlite3 --port 8765
pause
