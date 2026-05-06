@echo off
REM Launcher for twitch-upstream-checker.js
REM Polls Twitch Helix API to verify channels are actually live.
REM Config: twitch-api.json (gitignored). See docs/twitch-upstream-check-setup.md

cd /d "%~dp0"

echo ======================================
echo    Twitch Upstream Checker
echo ======================================
echo Verifies channels are live on Twitch
echo via Helix API (not local MediaMTX).
echo.

set /p MODE="Mode (1=continuous poll, 2=one-shot) [default: 1]: "
if "%MODE%"=="" set MODE=1

if "%MODE%"=="2" (
    echo Running: node twitch-upstream-checker.js --once
    node twitch-upstream-checker.js --once
) else (
    set /p INTERVAL="Poll interval ms [default: 60000]: "
    if "%INTERVAL%"=="" (
        echo Running: node twitch-upstream-checker.js
        node twitch-upstream-checker.js
    ) else (
        echo Running: node twitch-upstream-checker.js --interval %INTERVAL%
        node twitch-upstream-checker.js --interval %INTERVAL%
    )
)
pause
