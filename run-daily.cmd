@echo off
REM GitHub Trending daily push - entry point for Windows Task Scheduler.
REM Logging and output files are handled inside daily.js (Node), not by cmd.
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE=C:\Users\RainbowCatW\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
"%NODE_EXE%" "%SCRIPT_DIR%daily.js" --limit 10
exit /b %errorlevel%
