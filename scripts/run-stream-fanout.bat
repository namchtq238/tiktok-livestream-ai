@echo off
REM Interactive launcher for stream-fanout-runner.js
REM Docs: ../docs/requirements/note10-test-fanout-without-tiktok.md (§2.2)
REM       ../docs/twitch-test-setup.md

cd /d "%~dp0"

echo ======================================
echo    Stream Fanout Runner
echo ======================================
echo Choose fanout target:
echo   1) Loopback   - test local N destinations (rtmp://127.0.0.1/fanN)
echo   2) Twitch     - load test-twitch.json
echo   3) TikTok     - load tiktok-keys.json
echo   4) Variant    - load variant config (anti-duplicate, re-encode, multi-process)
echo.

set /p TARGET="Select target (1/2/3/4) [default: 1]: "
if "%TARGET%"=="" set TARGET=1

if "%TARGET%"=="1" goto LOOPBACK
if "%TARGET%"=="2" goto TWITCH
if "%TARGET%"=="3" goto TIKTOK
if "%TARGET%"=="4" goto VARIANT

echo Invalid selection: %TARGET%
goto END

:LOOPBACK
echo.
echo --- Loopback mode ---
echo Recommended: tee for N less than 10, multi for N greater than or equal to 10.
echo.

set /p COUNT="Number of fanout destinations (3/5/10/50) [default: 3]: "
if "%COUNT%"=="" set COUNT=3

set /p MODE="Mode (tee/multi) [default: tee]: "
if "%MODE%"=="" set MODE=tee

echo.
echo Running: node stream-fanout-runner.js --count %COUNT% --mode %MODE%
echo Press Ctrl+C to stop.
echo ======================================
echo.
node stream-fanout-runner.js --count %COUNT% --mode %MODE%
goto END

:TWITCH
if not exist "test-twitch.json" (
    echo.
    echo ERROR: test-twitch.json not found in %CD%
    echo.
    echo Create it first with your Twitch Stream Key:
    echo   {
    echo     "destinations": ["rtmp://live-sin.twitch.tv/app/live_YOUR_KEY"],
    echo     "mode": "tee"
    echo   }
    echo.
    echo See: ../docs/twitch-test-setup.md section 6
    goto END
)
echo.
echo --- Twitch mode ---
echo Config: test-twitch.json
echo Running: node stream-fanout-runner.js --config test-twitch.json
echo Press Ctrl+C to stop.
echo ======================================
echo.
node stream-fanout-runner.js --config test-twitch.json
goto END

:TIKTOK
if not exist "tiktok-keys.json" (
    echo.
    echo ERROR: tiktok-keys.json not found in %CD%
    echo.
    echo Create it first with your TikTok Stream Keys:
    echo   {
    echo     "destinations": [
    echo       "rtmps://push-live.tiktokcdn.com/live/KEY_ACC_1",
    echo       "rtmps://push-live.tiktokcdn.com/live/KEY_ACC_2",
    echo       "rtmps://push-live.tiktokcdn.com/live/KEY_ACC_3"
    echo     ],
    echo     "mode": "tee"
    echo   }
    echo.
    echo See: ../plans/260422-1625-policy-lach-phase-0-and-1/phase-00-prerequisite-stream-keys.md
    goto END
)
echo.
echo --- TikTok mode ---
echo Config: tiktok-keys.json
echo Running: node stream-fanout-runner.js --config tiktok-keys.json
echo Press Ctrl+C to stop.
echo ======================================
echo.
node stream-fanout-runner.js --config tiktok-keys.json
goto END

:VARIANT
echo.
echo --- Variant mode (anti-duplicate) ---
echo Always runs multi-process with re-encode (one ffmpeg per variant).
echo Config must define destinations with "variant" field.
echo.

set /p VARIANT_CONFIG="Variant config file [default: stream-fanout-runner.example-variant.config.json]: "
if "%VARIANT_CONFIG%"=="" set VARIANT_CONFIG=stream-fanout-runner.example-variant.config.json

if not exist "%VARIANT_CONFIG%" (
    echo.
    echo ERROR: %VARIANT_CONFIG% not found in %CD%
    echo.
    echo See example: stream-fanout-runner.example-variant.config.json
    echo Docs: ../docs/fanout-variant-mechanism.md
    goto END
)

echo.
echo Config: %VARIANT_CONFIG%
echo Running: node stream-fanout-runner.js --config %VARIANT_CONFIG%
echo Press Ctrl+C to stop.
echo ======================================
echo.
node stream-fanout-runner.js --config "%VARIANT_CONFIG%"
goto END

:END
pause
