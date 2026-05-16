@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist config\.env (
    echo Configuration not found. Please run setup.bat first.
    pause
    exit /b 1
)

dir /b /a:d chromium-cache\chromium-* >nul 2>&1
if errorlevel 1 (
    echo Chromium not installed yet. Please run bootstrap.bat first.
    pause
    exit /b 1
)

set ERP_ROOT=%~dp0
set CLOAKBROWSER_CACHE_DIR=%~dp0chromium-cache
set CLOAKBROWSER_AUTO_UPDATE=false
set ERP_FILE_LOGGING=true

echo Starting erepublik-agent. Close this window to stop the bot,
echo or double-click stop.bat. Logs: logs\agent-YYYY-MM-DD.log
echo.

node\node.exe app\dist\agent\runner.js

endlocal
