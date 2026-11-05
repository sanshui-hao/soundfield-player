@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Soundfield Mobile Access
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "SOUNDFIELD_HOST=0.0.0.0"

echo.
echo   SOUNDFIELD - starting phone access mode...
echo   Keep this window open.
echo   The phone URL will be printed below.
echo   Allow Python on private networks if Windows Firewall asks.
echo.

py -3 -c "import flask" >nul 2>nul
if not errorlevel 1 goto run_py
python -c "import flask" >nul 2>nul
if not errorlevel 1 goto run_python

echo   Python with Flask was not found on this computer.
echo   Install Python 3.10+ and run: pip install -r requirements.txt
goto finish

:run_py
echo   Using Python: py -3
py -3 app.py
goto finish

:run_python
echo   Using Python: python
python app.py
goto finish

:finish
echo.
echo   The player has stopped.
pause
