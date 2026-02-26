@echo off
echo ========================================
echo  ZeroTouch Mail AI SaaS - Setup Script
echo ========================================
echo.

REM Check if Node.js is installed
echo Checking for Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js is not installed!
    echo.
    echo Please install Node.js first:
    echo 1. Go to https://nodejs.org/
    echo 2. Download the LTS version
    echo 3. Install it
    echo 4. Restart this script
    echo.
    pause
    exit
)

echo Node.js found!
echo.

REM Install backend dependencies
echo Installing backend dependencies...
cd backend
call npm install
if errorlevel 1 (
    echo.
    echo ERROR: Failed to install dependencies
    pause
    exit
)

echo.
echo ========================================
echo  Installation Complete!
echo ========================================
echo.
echo Starting the backend server...
echo.
echo IMPORTANT: Keep this window open!
echo The server needs to stay running.
echo.
echo To open the app, double-click:
echo frontend\index.html
echo.
echo ========================================
echo.

REM Start the server
call npm start

pause
