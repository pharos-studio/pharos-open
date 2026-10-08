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
REM ------------------------------------------------------------
REM 2. Port check.
REM    *  The exact-match regex below needs the space after the port
REM      (":3000 .*LISTENING"), otherwise ":3000" also matches ":30001".
REM    *  An occupied port used to just print a warning and open the URL,
REM      which silently leaves you on an OLD copy of the running server.
REM      Now we name the PID and offer to replace it.
REM ------------------------------------------------------------
call :findpid
if defined PORT_PID goto :portbusy
goto :start

:portbusy
echo.
echo [WARN] Port %PORT% is already in use, by PID %PORT_PID%.
echo        Most likely an OLD copy of this server is still running.
echo        Opening the URL now would show stale code.
echo.
choice /c YN /n /t 0 /d Y /m "        Stop PID %PORT_PID% and start the current code? [Y/N] "
if errorlevel 2 goto :keepold
echo        Stopping PID %PORT_PID% ...
taskkill /PID %PORT_PID% /F >nul 2>&1
timeout /t 2 /nobreak >nul
call :findpid
if defined PORT_PID (
  echo.
  echo [ERROR] Port %PORT% is still held, now by PID %PORT_PID%.
  echo         Close that program and run this file again.
  echo.
  pause
  exit /b 1
)
echo        Stopped.
echo.

:start
echo   node runtime    : %NODE_EXE%
echo   starting server on port %PORT% ...
start "Pharos" "%NODE_EXE%" backend/server.js
REM ------------------------------------------------------------
REM 2b. Wait for the server to actually answer.
REM     Starting is not serving: a crash on boot used to look identical
REM     to a healthy start, and the browser just showed a dead page.
REM ------------------------------------------------------------
call :waitready
if not defined READY goto :notready

:showurls
call :vercheck
echo.
echo ============================================================
echo   On this PC     :  http://localhost:%PORT%
echo   On your phone  :  use ONE of these, same WiFi required
echo ------------------------------------------------------------
set "FOUND_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do call :showip %%a
if not defined FOUND_IP echo   [!] No LAN IP found - WiFi not connected?
echo ============================================================
echo   Code version   : %VER%
echo ============================================================
start "" http://localhost:%PORT%
echo.
echo   This window stays open so you can read the phone URL.
echo   Press any key to close it - the server keeps running.
pause >nul
exit /b 0

:notready
echo.
echo [ERROR] The server did not answer on http://localhost:%PORT%/
echo         within 20 seconds. Open the "Pharos" window to see why.
echo.
pause
exit /b 1

:keepold
echo        Keeping the running instance.
echo        If the page looks stale, close that "Pharos" window
echo        (or kill PID %PORT_PID%) and run this file again.
echo.
goto :showurls

REM --- sub: find the PID holding our port (exact match only) ---
:findpid
set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING" 2^>nul') do set "PORT_PID=%%p"
goto :eof

REM --- sub: poll until the server answers /api/state ---
:waitready
set "READY="
for /l %%i in (1,1,20) do call :tryready
goto :eof

:tryready
if defined READY goto :eof
set "CODE="
for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" http://localhost:%PORT%/api/state 2^>nul`) do set "CODE=%%c"
if "%CODE%"=="200" set "READY=1"
if not defined READY timeout /t 1 /nobreak >nul
goto :eof

REM --- sub: is the running instance built from the current code? ---
REM     /api/fund-degraded exists only in the current build, so ANY
REM     non-404 answer proves the route is there; 404 proves it is not.
REM     Do NOT key on 400: a well-formed but nonexistent code (000000)
REM     passes validation and falls through to the NAV fetch, which
REM     answers 502 - that was the first version of this check and it
REM     mislabelled a current build as "unknown".
:vercheck
set "VER=unknown (curl.exe not available - skip)"
for /f "usebackq delims=" %%c in (`curl.exe -s -o NUL -w "%%{http_code}" "http://localhost:%PORT%/api/fund-degraded?code=000000" 2^>nul`) do call :setver %%c
goto :eof

:setver
if "%~1"=="" goto :eof
if "%~1"=="000" goto :eof
if "%~1"=="404" set "VER=OLD CODE - missing /api/fund-degraded"
if not "%~1"=="404" if not "%~1"=="000" set "VER=current code"
goto :eof

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