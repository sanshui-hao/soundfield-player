@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Soundfield Player
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

echo.
echo   SOUNDFIELD - starting local player...
echo   Keep this window open. The browser will open automatically.
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
echo   If the browser did not open, use the address printed above.
pause
