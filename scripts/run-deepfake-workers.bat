@echo off
REM Interactive launcher for worker-per-TikTok Deep-Live-Cam streaming.
REM Copy deepfake-worker-runner.example.config.json to deepfake-worker-runner.config.json first.

cd /d "%~dp0"

echo ======================================
echo    Deepfake Worker Runner
echo ======================================
echo This runner starts one Deep-Live-Cam worker per destination.
echo Each worker pulls the same source stream, swaps a synthetic avatar face,
echo and publishes directly to its configured RTMP/RTMPS destination.
echo.

set CONFIG=deepfake-worker-runner.config.json
if not exist "%CONFIG%" (
    echo ERROR: %CONFIG% not found.
    echo.
    echo Copy deepfake-worker-runner.example.config.json to %CONFIG%,
    echo set deepLiveCamRoot, avatarPath values, and destination URL env vars.
    echo.
    goto END
)

echo Config: %CONFIG%
echo Source and worker settings are loaded from the config file.
echo Press Ctrl+C to stop all workers.
echo ======================================
echo.

node deepfake-worker-runner.js --config "%CONFIG%"

:END
pause
