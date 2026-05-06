@echo off
REM Launch Chrome with custom profile for TikTok automation

if "%1"=="" (
    echo Usage: launch-chrome.bat ^<accountId^>
    echo Example: launch-chrome.bat acc1
    exit /b 1
)

set ACCOUNT_ID=%1
set PROJECT_DIR=%~dp0..
set PROFILE_DIR=%PROJECT_DIR%\data\profiles\%ACCOUNT_ID%

echo Launching Chrome with profile: %PROFILE_DIR%
echo.
echo INSTRUCTIONS:
echo 1. Chrome will open with a fresh/existing profile
echo 2. Navigate to https://www.tiktok.com
echo 3. Login with your TikTok account
echo 4. Wait until you see the For You page
echo 5. Close Chrome when done
echo.
echo Press any key to launch Chrome...
pause >nul

"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%"

if errorlevel 1 (
    echo.
    echo Chrome launch failed. Trying alternative path...
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%"
)

echo.
echo Chrome closed. Profile saved to: %PROFILE_DIR%
echo.
echo Next step: Verify the profile
echo   node dist/tools/verify-profile.js %ACCOUNT_ID%
echo.
pause
