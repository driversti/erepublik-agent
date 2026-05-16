erepublik-agent -- Windows portable build
==========================================

What this is
------------
A bot for eRepublik that performs your daily actions (work, train,
buy food, claim missions) and runs gold-farming sessions across
empty-division battles, automatically. Runs in the background; you
configure once and forget.

System requirements
-------------------
- Windows 10 or 11, 64-bit.
- ~500 MB free disk space (50 MB ZIP + 200 MB Chromium download).
- A working internet connection during first bootstrap.
- No admin rights needed.

Quick start
-----------
1. Extract this ZIP anywhere. Desktop is fine.
2. Double-click setup.bat.
   You will be asked for your eRepublik login, password, and a few
   tuning options. Press Enter to accept any default.
3. Double-click bootstrap.bat.
   The first run downloads CloakBrowser Chromium (~200 MB, 3-5 min).
   A browser window then opens at the eRepublik login page -- sign in
   manually. The window closes automatically once you're logged in.
4. Double-click start.bat.
   The bot starts running. Minimize the window. Done.

Stopping the bot
----------------
- Double-click stop.bat, OR
- Close the start.bat console window directly.

Logs
----
Every cycle is logged to logs\agent-YYYY-MM-DD.log. If something
breaks and you need help, send the most recent log file.

Updating
--------
Download the new ZIP, extract over the existing folder. Your
sessions\ and config\ contents are preserved.

Troubleshooting
---------------
1. "Windows protected your PC" SmartScreen warning
   Click "More info" then "Run anyway". The .bat files are not signed.

2. bootstrap.bat fails during Chromium download
   Your network is blocking the CloakBrowser CDN. If you're on
   corporate Wi-Fi or VPN, switch to a personal network for the
   first bootstrap. Once chromium-cache\ is populated, network
   restrictions don't matter for normal runs (only eRepublik and
   optionally Telegram are contacted).

3. Antivirus quarantines chromium-cache\...\chrome.exe
   Add the install folder to your antivirus exclusion list.

4. Login screen reappears every day
   Session expired. Rerun bootstrap.bat. Chromium does NOT
   re-download -- only the login is repeated.

5. "No running agent found." when running stop.bat
   The bot wasn't running. Use Task Manager to check.

Disclaimer
----------
Automation against an online game violates eRepublik Terms of
Service. Use at your own risk. We cannot guarantee your account
will not be sanctioned. There is no telemetry -- your credentials
never leave your machine.
