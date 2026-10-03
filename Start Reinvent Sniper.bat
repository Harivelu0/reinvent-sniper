@echo off
title Reinvent Sniper
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install the LTS version from https://nodejs.org , then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing the one dependency. This takes a few seconds...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

node server.js
echo.
echo The app has stopped.
pause
