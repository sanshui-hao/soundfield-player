@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Soundfield Remote Access
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo.
echo   SOUNDFIELD - starting phone remote access...
echo   Keep this window open.
echo   The phone URL and access code will be printed below.
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
py -3 remote.py
goto finish

:run_python
echo   Using Python: python
python remote.py
goto finish

:finish
echo.
echo   Remote access has stopped.
pause
