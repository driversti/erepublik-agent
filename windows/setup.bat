@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist config mkdir config
set "ENVFILE=config\.env"
set "TMPFILE=config\.env.new"

:: Defaults (used when no existing .env is found, or when the user
:: keeps the bracketed default by pressing Enter).
set "CUR_LOGIN="
set "CUR_PASSWORD="
set "CUR_SLUG=main"
set "CUR_MAX_FOOD=3.0"
set "CUR_FARM_MAX_CC=400"
set "CUR_FARM_MIN_FUEL=10"
set "CUR_FARM_BLOCKED_CSV="
set "CUR_RETURN_HOME_MIN=15"
set "CUR_RETURN_HOME_MAX_CC=500"
set "CUR_TG_TOKEN="
set "CUR_TG_CHAT="
set "CUR_CAPTCHA=none"
set "CUR_CAPTCHA_KEY="

:: Pre-populate defaults from existing .env if present.
if exist "%ENVFILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ENVFILE%") do (
        if "%%a"=="ERP_LOGIN" set "CUR_LOGIN=%%b"
        if "%%a"=="ERP_PASSWORD" set "CUR_PASSWORD=%%b"
        if "%%a"=="ERP_ACCOUNT_SLUG" set "CUR_SLUG=%%b"
        if "%%a"=="ERP_MAX_FOOD_PRICE" set "CUR_MAX_FOOD=%%b"
        if "%%a"=="ERP_FARM_MAX_TRAVEL_CC" set "CUR_FARM_MAX_CC=%%b"
        if "%%a"=="ERP_FARM_MIN_FUEL" set "CUR_FARM_MIN_FUEL=%%b"
        if "%%a"=="ERP_FARM_BLOCKED_COUNTRIES" set "CUR_FARM_BLOCKED_CSV=%%b"
        if "%%a"=="ERP_RETURN_HOME_AFTER_MINUTES" set "CUR_RETURN_HOME_MIN=%%b"
        if "%%a"=="ERP_RETURN_HOME_MAX_CC" set "CUR_RETURN_HOME_MAX_CC=%%b"
        if "%%a"=="TELEGRAM_BOT_TOKEN" set "CUR_TG_TOKEN=%%b"
        if "%%a"=="TELEGRAM_CHAT_ID" set "CUR_TG_CHAT=%%b"
        if "%%a"=="ERP_CAPTCHA_PROVIDER" set "CUR_CAPTCHA=%%b"
        if "%%a"=="ERP_CAPTCHA_API_KEY" set "CUR_CAPTCHA_KEY=%%b"
    )
)

:: Now enable delayed expansion for the user-interaction portion.
setlocal enabledelayedexpansion

echo.
echo =====================================================
echo   erepublik-agent setup
echo =====================================================
echo.
echo This wizard will configure the bot. Press Enter to
echo keep the default shown in [brackets], or type a new
echo value. Run this again any time to change settings.
echo.

echo --- Account ---
call :prompt "eRepublik email address" "%CUR_LOGIN%" LOGIN
call :prompt_password "eRepublik password" "%CUR_PASSWORD%" PASSWORD
call :prompt "Account label" "%CUR_SLUG%" SLUG

echo.
echo --- Daily actions ---
call :prompt "Maximum Q1 food price" "%CUR_MAX_FOOD%" MAX_FOOD

echo.
echo --- Gold farming (always on; tuned by weekly fuel budget) ---
call :prompt "Max travel cost per battle hop, in CC" "%CUR_FARM_MAX_CC%" FARM_MAX_CC
call :prompt "Minimum fuel barrels to keep in inventory" "%CUR_FARM_MIN_FUEL%" FARM_MIN_FUEL

:blocked_prompt
echo.
echo Blocked countries (names or IDs, comma-separated; e.g. "Poland, Romania, 33")
echo Type 'list' to see all available countries, blank for none.
set "BLOCKED_RAW=%CUR_FARM_BLOCKED_CSV%"
set /p "BLOCKED_RAW=> "
if /i "!BLOCKED_RAW!"=="list" (
    node\node.exe app\dist\util\resolveCountriesCli.js --list
    echo.
    goto blocked_prompt
)
if defined BLOCKED_RAW (
    if not "!BLOCKED_RAW!"=="" (
        for /f "delims=" %%r in ('node\node.exe app\dist\util\resolveCountriesCli.js "!BLOCKED_RAW!" 2^>nul') do set "FARM_BLOCKED_CSV=%%r"
        if errorlevel 1 (
            node\node.exe app\dist\util\resolveCountriesCli.js "!BLOCKED_RAW!"
            echo Please try again.
            goto blocked_prompt
        )
    )
)

:: Leak FARM_BLOCKED_CSV out of the current setlocal scope. The next
:: :prompt call below does endlocal/setlocal and would otherwise discard
:: it -- leaving blocked-countries silently missing from .env. We always
:: leak (even when empty); the writer block below filters on non-empty.
endlocal & set "FARM_BLOCKED_CSV=%FARM_BLOCKED_CSV%"
setlocal enabledelayedexpansion

echo.
echo --- Auto return-home ---
call :prompt "Return home after how many minutes abroad (0 disables)" "%CUR_RETURN_HOME_MIN%" RETURN_HOME_MIN
call :prompt "Max return-home travel cost" "%CUR_RETURN_HOME_MAX_CC%" RETURN_HOME_MAX_CC

echo.
echo --- Telegram notifications (optional) ---
echo Press Enter twice to skip Telegram setup.
call :prompt "Telegram bot token" "%CUR_TG_TOKEN%" TG_TOKEN
call :prompt "Telegram chat ID" "%CUR_TG_CHAT%" TG_CHAT

echo.
echo --- Captcha solver (optional) ---
call :prompt "Captcha provider [none/2captcha]" "%CUR_CAPTCHA%" CAPTCHA
if /i "!CAPTCHA!"=="2captcha" (
    call :prompt "2captcha API key" "%CUR_CAPTCHA_KEY%" CAPTCHA_KEY
)

echo.
echo Writing %ENVFILE%...

(
    echo ERP_LOGIN=!LOGIN!
    echo ERP_PASSWORD=!PASSWORD!
    echo ERP_ACCOUNT_SLUG=!SLUG!
    echo ERP_MAX_FOOD_PRICE=!MAX_FOOD!
    echo HEADED=false
    echo LOOP_INTERVAL_MS=600000
    echo ERP_FARM_MAX_TRAVEL_CC=!FARM_MAX_CC!
    echo ERP_FARM_MIN_FUEL=!FARM_MIN_FUEL!
    if not "!FARM_BLOCKED_CSV!"=="" echo ERP_FARM_BLOCKED_COUNTRIES=!FARM_BLOCKED_CSV!
    echo ERP_RETURN_HOME_AFTER_MINUTES=!RETURN_HOME_MIN!
    echo ERP_RETURN_HOME_MAX_CC=!RETURN_HOME_MAX_CC!
    if defined TG_TOKEN echo TELEGRAM_BOT_TOKEN=!TG_TOKEN!
    if defined TG_CHAT echo TELEGRAM_CHAT_ID=!TG_CHAT!
    echo ERP_CAPTCHA_PROVIDER=!CAPTCHA!
    if defined CAPTCHA_KEY echo ERP_CAPTCHA_API_KEY=!CAPTCHA_KEY!
) > "%TMPFILE%"

move /y "%TMPFILE%" "%ENVFILE%" >nul

echo OK.
echo.
echo Next step: double-click bootstrap.bat to log in to eRepublik.
echo.
pause
exit /b 0

:prompt
:: %1 = prompt text, %2 = default, %3 = output var name
set "_VAL=%~2"
set /p "_VAL=%~1 [%~2]: "
endlocal & set "%~3=%_VAL%"
setlocal enabledelayedexpansion
goto :eof

:prompt_password
:: Use PowerShell to read masked input. Default visible in prompt.
::
:: We capture PowerShell's output via a temp file rather than `for /f` because
:: when stdout is redirected, Read-Host can emit the prompt label (or other
:: host chatter) into the captured stream, which then overwrites _VAL with
:: junk instead of leaving it on the default. A temp file isolates the
:: password value cleanly.
set "_DEFAULT=%~2"
set "_VAL=%_DEFAULT%"
if "%_DEFAULT%"=="" (
    set "_LABEL=%~1"
) else (
    set "_LABEL=%~1 [press Enter to keep current]"
)
set "_TMPFILE=%TEMP%\erp-setup-pwd-%RANDOM%-%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Read-Host -AsSecureString '!_LABEL!'; $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($p); $s = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($b); [System.IO.File]::WriteAllText('!_TMPFILE!', $s, [System.Text.UTF8Encoding]::new($false))" >nul
if exist "!_TMPFILE!" (
    for /f "usebackq delims=" %%a in ("!_TMPFILE!") do set "_VAL=%%a"
    del /q "!_TMPFILE!" >nul 2>&1
)
endlocal & set "%~3=%_VAL%"
setlocal enabledelayedexpansion
goto :eof
