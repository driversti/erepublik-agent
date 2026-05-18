@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo =====================================================
echo   erepublik-agent -- Update
echo =====================================================
echo.
echo This will download the latest release from GitHub and
echo replace only the bot code. Your config\, sessions\,
echo chromium-cache\, and logs\ folders are preserved --
echo you will NOT need to log in again.
echo.
echo Before continuing, please make sure the bot is stopped
echo (close the start.bat window, or run stop.bat).
echo.
pause

set "REPO=driversti/erepublik-agent"
set "STAGING=%~dp0.update-staging"
set "ZIPFILE=%STAGING%\release.zip"

REM Read current version (best-effort; used for the "already up to date" check).
set "CURRENT_VERSION=unknown"
if exist app\VERSION set /p CURRENT_VERSION=<app\VERSION

REM Clear any leftover staging from a previous failed run.
if exist "%STAGING%" rmdir /s /q "%STAGING%"
mkdir "%STAGING%"

echo.
echo Querying GitHub for the latest release...

REM Ask the GitHub API for the latest release; have PowerShell write the
REM tag (line 1) and the Windows ZIP download URL (line 2) to a temp file.
REM Going via a file avoids the for-/f-backtick quoting trap where cmd
REM reinterprets `|` characters inside the captured command line even when
REM they sit inside double quotes.
set "METAFILE=%STAGING%\release-meta.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; try { $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/%REPO%/releases/latest' -Headers @{ 'User-Agent' = 'erepublik-agent-updater' }; $tag = $r.tag_name -replace '^v',''; $asset = $r.assets | Where-Object { $_.name -like '*windows-x64.zip' } | Select-Object -First 1; if (-not $asset) { throw 'No Windows ZIP asset found in latest release.' }; Set-Content -Path '%METAFILE%' -Encoding ASCII -Value @($tag, $asset.browser_download_url) } catch { Write-Error $_.Exception.Message; exit 1 }"

if errorlevel 1 (
    echo.
    echo ERROR: Could not query GitHub. Check your internet connection.
    echo If you are behind a corporate firewall or VPN, try a personal network.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

if not exist "%METAFILE%" (
    echo.
    echo ERROR: GitHub query returned no metadata file.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

set "LATEST_VERSION="
set "DOWNLOAD_URL="
set /a _meta_line=0
for /f "usebackq delims=" %%i in ("%METAFILE%") do (
    set /a _meta_line+=1
    if !_meta_line! equ 1 set "LATEST_VERSION=%%i"
    if !_meta_line! equ 2 set "DOWNLOAD_URL=%%i"
)

if not defined LATEST_VERSION (
    echo.
    echo ERROR: Could not parse latest version from GitHub response.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

if not defined DOWNLOAD_URL (
    echo.
    echo ERROR: Could not parse download URL from GitHub response.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

echo Current version : %CURRENT_VERSION%
echo Latest version  : !LATEST_VERSION!

if "%CURRENT_VERSION%"=="!LATEST_VERSION!" (
    echo.
    echo You are already on the latest version. Nothing to do.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 0
)

echo.
echo Downloading release ZIP...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '!DOWNLOAD_URL!' -OutFile '!ZIPFILE!' -Headers @{ 'User-Agent' = 'erepublik-agent-updater' }"
if errorlevel 1 (
    echo ERROR: Download failed.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

echo Extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; Expand-Archive -Path '!ZIPFILE!' -DestinationPath '!STAGING!' -Force"
if errorlevel 1 (
    echo ERROR: Extraction failed.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

REM The ZIP contains a single top-level folder named "erepublik-agent\".
set "EXTRACTED=%STAGING%\erepublik-agent"
if not exist "%EXTRACTED%\app\dist" (
    echo ERROR: Unexpected ZIP layout. Expected app\dist not found.
    rmdir /s /q "%STAGING%"
    pause
    exit /b 1
)

echo.
echo Replacing application files (app\)...
REM /MIR mirrors the source: copies new + removes stale files. Safe because all
REM runtime state (config, sessions, logs, chromium-cache) is outside app\.
robocopy "%EXTRACTED%\app" "%~dp0app" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo ERROR: Failed to update app\ (robocopy exit %errorlevel%).
    echo The install may be in a half-updated state. Re-run this script,
    echo or extract the ZIP manually from %ZIPFILE%.
    pause
    exit /b 1
)

echo Updating launcher scripts and README...
REM Copy only top-level .bat + README. /XF excludes update.bat (this very
REM script) to avoid Windows overwriting the file we are running.
robocopy "%EXTRACTED%" "%~dp0" *.bat README.txt /XF update.bat /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo WARNING: Some launcher files could not be updated (robocopy exit %errorlevel%).
    echo The app\ folder is updated but .bat files may be stale. Re-run if needed.
)

REM A new update.bat may be present in the release. We cannot overwrite
REM ourselves while running, so stage it as update.bat.new. The user is
REM prompted (below) to rename it manually next time -- this only matters
REM for releases that change update.bat itself, which should be rare.
if exist "%EXTRACTED%\update.bat" copy /Y "%EXTRACTED%\update.bat" "%~dp0update.bat.new" >nul

rmdir /s /q "%STAGING%"

echo.
echo =====================================================
echo   Update complete: %CURRENT_VERSION% -^> !LATEST_VERSION!
echo =====================================================
echo.
if exist update.bat.new (
    echo NOTE: A new version of update.bat was downloaded as
    echo       update.bat.new. To apply it, close this window
    echo       and rename update.bat.new -^> update.bat manually.
    echo.
)
echo Double-click start.bat to run the new version.
pause
endlocal
exit /b 0
