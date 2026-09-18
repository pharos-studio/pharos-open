@echo off
title Pharos Setup
REM ============================================================
REM   Pharos - first-run setup
REM   Creates your local data files from the sanitized templates.
REM   Existing files are NEVER overwritten, so it is safe to re-run.
REM
REM   NOTE: this file is intentionally ASCII-only.
REM   Chinese chars combined with goto/call break cmd's file
REM   pointer and make it run half a character as a command.
REM ============================================================
cd /d "%~dp0"
REM ------------------------------------------------------------
REM 1. Locate node.exe (auto-detect, never hardcode a version)
REM ------------------------------------------------------------
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" call :setnode "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" call :setnode "%LOCALAPPDATA%\Programs\nodejs\node.exe"
)
if not defined NODE_EXE (
  for /f "delims=" %%n in ('where node 2^>nul') do call :setnode "%%n"
)
if not defined NODE_EXE (
  echo.
  echo [ERROR] node.exe not found.
  echo   Install Node.js 18 or newer, then run this file again.
  echo.
  call :maybe_pause
  exit /b 1
)
echo   node runtime : %NODE_EXE%
echo.
REM ------------------------------------------------------------
REM 2. Generate local data files (idempotent)
REM ------------------------------------------------------------
"%NODE_EXE%" "%~dp0backend\scripts\setup.js"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
  echo [ERROR] setup did not finish - see the messages above.
  call :maybe_pause
  exit /b %RC%
)
echo   Next step: double-click start.bat
echo.
call :maybe_pause
exit /b 0

REM --- sub: record node.exe only if the file really exists ---
:setnode
if defined NODE_EXE goto :eof
if exist "%~1" set "NODE_EXE=%~1"
goto :eof

REM --- sub: pause unless PHAROS_NO_PAUSE is set (CI must not hang) ---
:maybe_pause
if defined PHAROS_NO_PAUSE goto :eof
pause
goto :eof
