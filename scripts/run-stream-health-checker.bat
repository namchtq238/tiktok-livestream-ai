@echo off
REM Launcher for stream-health-checker.js
REM Prompts for count to match fanout runner. Leave blank to use config file.
REM Docs: ../docs/requirements/note10-test-fanout-without-tiktok.md (§2.4)

cd /d "%~dp0"

echo ======================================
echo    Stream Health Checker
echo ======================================
echo Monitor RTMP paths via ffprobe.
echo Should match --count of fanout runner.
echo.

set /p COUNT="Number of fanout paths to monitor (blank = use config): "

if "%COUNT%"=="" (
    echo Running: node stream-health-checker.js
    node stream-health-checker.js
) else (
    echo Running: node stream-health-checker.js --count %COUNT%
    node stream-health-checker.js --count %COUNT%
)
pause
