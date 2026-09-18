@echo off
title Pharos Launcher
REM ============================================================
REM   Pharos - one-click launcher
REM   Double-click this file to start the local server.
REM   Close the "Pharos" window to stop the server.
REM
REM   NOTE: this file is intentionally ASCII-only.
REM   Chinese chars combined with goto/call break cmd's file
REM   pointer and make it run half a character as a command.
REM ============================================================
cd /d "%~dp0"
REM ------------------------------------------------------------
REM 0. Port. Override by setting PORT before running the bat.
REM ------------------------------------------------------------
if not defined PORT set "PORT=3000"
REM ------------------------------------------------------------
REM 1. Locate node.exe (auto-detect, never hardcode a version)
REM ------------------------------------------------------------
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" call :setnode "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  for /f "delims=" %%n in ('where node 2^>nul') do call :setnode "%%n"
)
if not defined NODE_EXE (
  echo.
  echo [ERROR] node.exe not found.
  echo   Install Node.js 18 or newer, and make sure it is on PATH.
  echo   Open a new terminal and run: node -v
  echo.
  pause
  exit /b 1
)
echo   node runtime   : %NODE_EXE%
echo.
REM ------------------------------------------------------------
REM 2. Start the server, unless the port is already taken
REM ------------------------------------------------------------
netstat -ano | findstr ":%PORT%" | findstr /i "LISTENING" >nul
if %errorlevel%==0 (
  echo   [WARN] port %PORT% is already in use - server may be running.
  echo          Skipping start; just open the URL below.
  echo.
  goto :showurls
)
start "Pharos" "%NODE_EXE%" backend/server.js
timeout /t 2 /nobreak >nul
:showurls
REM ------------------------------------------------------------
REM 3. Show every LAN address the phone can use
REM ------------------------------------------------------------
echo.
echo ============================================================
echo   On this PC     :  http://localhost:%PORT%
echo   On your phone  :  use ONE of these, same WiFi required
echo ------------------------------------------------------------
set "FOUND_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do call :showip %%a
if not defined FOUND_IP echo   [!] No LAN IP found - WiFi not connected?
echo ============================================================
echo   Phone cannot open it? Turn VPN / HTTP proxy OFF,
echo   or the IP changed - reopen this file for the new one.
echo   In the phone browser use "Add to Home screen" for 1-tap.
echo ============================================================
start "" http://localhost:%PORT%
echo.
echo   This window stays open so you can read the phone URL.
echo   Press any key to close it - the server keeps running.
pause >nul
exit

:showip
set "ip=%1"
if not defined ip goto :eof
if "%ip:~0,7%"=="169.254" goto :eof
set "FOUND_IP=1"
echo        http://%ip%:%PORT%
goto :eof

REM --- sub: record node.exe only if the file really exists ---
:setnode
if defined NODE_EXE goto :eof
if exist "%~1" set "NODE_EXE=%~1"
goto :eof
