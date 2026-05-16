@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist config\.env (
    echo Configuration not found. Please run setup.bat first.
    pause
    exit /b 1
)

set ERP_ROOT=%~dp0
set CLOAKBROWSER_CACHE_DIR=%~dp0chromium-cache
set CLOAKBROWSER_AUTO_UPDATE=false
set HEADED=true

if not exist chromium-cache mkdir chromium-cache

dir /b /a:d chromium-cache\chromium-* >nul 2>&1
if errorlevel 1 (
    echo.
    echo ==========================================================
    echo   First-time setup: downloading CloakBrowser Chromium
    echo   ~200 MB, typically 3-5 minutes on a fast connection.
    echo   This happens once per install.
    echo ==========================================================
    echo.
    node\node.exe app\node_modules\cloakbrowser\dist\cli.js install
    if errorlevel 1 (
        echo.
        echo ERROR: Failed to download CloakBrowser Chromium.
        echo Check your internet connection. If you are behind a
        echo corporate firewall or VPN, see README.txt "Troubleshooting".
        pause
        exit /b 1
    )
    echo.
    echo Chromium download complete. Proceeding to login.
    echo.
)

node\node.exe app\dist\bootstrap.js
if errorlevel 1 (
    echo.
    echo Login failed. See logs\bootstrap.log for details.
    pause
    exit /b 1
)

echo.
echo Login successful. Double-click start.bat to begin.
pause
endlocal
exit /b 0
