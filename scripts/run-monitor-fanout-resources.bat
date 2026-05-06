@echo off
REM Launcher for monitor-fanout-resources.ps1
REM Usage: double-click, or pass args: run-monitor-fanout-resources.bat [interval] [--per-proc]
REM Examples:
REM   run-monitor-fanout-resources.bat              (default 60s interval)
REM   run-monitor-fanout-resources.bat 30           (30s interval)
REM   run-monitor-fanout-resources.bat 30 --per-proc (30s + per-process breakdown)
REM Docs: ../docs/requirements/note10-test-fanout-without-tiktok.md

cd /d "%~dp0"

set INTERVAL=60
set PERPROC=

if not "%1"=="" set INTERVAL=%1
if "%2"=="--per-proc" set PERPROC=-ShowPerProcess

powershell -NoProfile -ExecutionPolicy Bypass -File .\monitor-fanout-resources.ps1 -IntervalSeconds %INTERVAL% %PERPROC%
pause
