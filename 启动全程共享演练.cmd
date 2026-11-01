@echo off
cd /d "%~dp0"
python -X utf8 server.py --demo --port 8765
pause
