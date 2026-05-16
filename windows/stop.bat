@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist logs\agent.pid (
    echo No running agent found.
    pause
    exit /b 0
)

set /p PID=<logs\agent.pid
taskkill /PID %PID% /F >nul 2>&1
del logs\agent.pid >nul 2>&1
echo Agent stopped (PID %PID%).
pause
endlocal
exit /b 0
