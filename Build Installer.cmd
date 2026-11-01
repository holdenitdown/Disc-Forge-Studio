@echo off
setlocal
title DiscForge Studio - build installer
cd /d "%~dp0"

echo.
echo  DiscForge Studio - building the Windows installer
echo  ==================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install Node.js 22 LTS from https://nodejs.org and run this again.
  goto :fail
)
for /f "delims=" %%v in ('node -v') do echo  Node.js %%v

echo.
echo  [1/3] Installing build dependencies (npm ci)...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail

echo.
echo  [2/3] Collecting FFmpeg, tsMuxeR, dvdauthor and the other tools...
call node scripts\fetch-tools.js
if errorlevel 1 goto :fail

echo.
echo  [3/3] Packaging the installer (electron-builder)...
call npx electron-builder --win nsis --x64
if errorlevel 1 goto :fail

for %%f in (dist\DiscForge-Studio-Setup-*.exe) do (
  copy /y "%%f" "..\%%~nxf" >nul
  echo.
  echo  Done!
  echo    %CD%\%%f
  echo    copied to %~dp0..\%%~nxf
)
echo.
echo  Build finished successfully. > build-result.txt
pause
exit /b 0

:fail
echo.
echo  The build failed. Scroll up to see the error.
echo  Build FAILED. > build-result.txt
pause
exit /b 1
