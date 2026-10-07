@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title 舰装格局 - 开发模式

echo [DEV] Development mode keeps log windows open and enables hot reload.
echo [DEV] For normal use, run 启动配装工具.bat instead.

set "RUNTIME_DIR=%LOCALAPPDATA%\EveFrontierFitter"
set "VENV_DIR=%RUNTIME_DIR%\venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"

if not exist "%PYTHON_EXE%" (
  set "SYSTEM_PYTHON="
  for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%~fD\python.exe" set "SYSTEM_PYTHON=%%~fD\python.exe"
  if not defined SYSTEM_PYTHON (
    py -3 --version >nul 2>nul
    if not errorlevel 1 set "SYSTEM_PYTHON=py -3"
  )
  if not defined SYSTEM_PYTHON (
    echo [ERROR] Python 3 was not found. Install Python 3.11 or newer and run this file again.
    pause
    exit /b 1
  )
  echo [SETUP] Creating the local CP-SAT Python environment...
  if "!SYSTEM_PYTHON!"=="py -3" (
    py -3 -m venv "%VENV_DIR%"
  ) else (
    "!SYSTEM_PYTHON!" -m venv "%VENV_DIR%"
  )
  if errorlevel 1 goto :failed
)

echo [SETUP] Checking Python dependencies...
"%PYTHON_EXE%" -m pip install -q -r "%~dp0backend\requirements.txt"
if errorlevel 1 goto :failed

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found. Install Node.js and enable pnpm, then run this file again.
  pause
  exit /b 1
)

echo [START] CP-SAT service: http://127.0.0.1:8765
start "EVE Frontier CP-SAT" /D "%~dp0backend" cmd /k ""%PYTHON_EXE%" -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --reload"
echo [START] Web app: see the Local URL in the frontend window.
start "EVE Frontier Fitter" /D "%~dp0" cmd /k "pnpm run dev"
exit /b 0

:failed
echo [ERROR] Setup failed. See backend\README.md for manual startup commands.
pause
exit /b 1
