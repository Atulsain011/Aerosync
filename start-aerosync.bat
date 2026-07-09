@echo off
:: ==============================================================================
:: AeroSync Local Server One-Click Launcher (Windows)
:: ==============================================================================
title AeroSync File Share Launcher

cd /d "%~dp0"

echo =============================================
echo  📡 Starting AeroSync File Server Launcher...
echo =============================================

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Error: Node.js is not installed on this system!
    echo Please download and install Node.js from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: 2. Check if node_modules is installed
if not exist "node_modules\" (
    echo 📦 Dependencies missing. Running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo ❌ Error: Failed to install project dependencies.
        pause
        exit /b 1
    )
)

:: 3. Start the node server
echo 🚀 Starting AeroSync engine...
echo 🌐 Launching UI dashboard at http://localhost:5000...
echo Keep this terminal open to keep sharing files.
echo Press Ctrl+C in this terminal to stop the server.
echo =============================================

:: Start browser after a short delay
start "" http://localhost:5000

:: Start server
npm start

pause
