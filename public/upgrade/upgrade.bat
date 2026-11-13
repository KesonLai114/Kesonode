@echo off
rem Kesonode one-click upgrade helper (Windows 10 or newer).
rem A browser extension cannot replace its own files. This script only unpacks the
rem downloaded zip into a BRAND NEW folder and copies that path; the browser still
rem requires you to remove the old extension and choose "Load unpacked".
rem English only on purpose: console output must stay readable under any OEM code page.
setlocal
title Kesonode upgrade helper

echo.
echo === Kesonode upgrade helper ===
echo.

set "ZIP=%~1"
if not defined ZIP (
  for /f "delims=" %%F in ('dir /b /o-d "%USERPROFILE%\Downloads\kesonode-*.zip" 2^>nul') do (
    if not defined ZIP set "ZIP=%USERPROFILE%\Downloads\%%F"
  )
)
if not defined ZIP (
  for /f "delims=" %%F in ('dir /b /o-d "%~dp0kesonode-*.zip" 2^>nul') do (
    if not defined ZIP set "ZIP=%~dp0%%F"
  )
)
if not defined ZIP (
  echo No kesonode-*.zip found in Downloads or next to this script.
  echo Download the package in Settings first, or drag the zip onto this script.
  goto :end
)
echo Package: %ZIP%

for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%T"
if not defined STAMP set "STAMP=%RANDOM%"
set "DEST=%USERPROFILE%\Downloads\Kesonode-upgrade-%STAMP%"
mkdir "%DEST%" 2>nul
if errorlevel 1 (
  echo Cannot create %DEST%
  goto :end
)

echo Unpacking into a fresh folder ...
tar -xf "%ZIP%" -C "%DEST%" 2>nul
if errorlevel 1 (
  echo Unpacking failed. Windows 10 or newer is required, or unzip the package manually.
  goto :end
)
if not exist "%DEST%\manifest.json" (
  echo manifest.json was not found at the root of the unpacked folder.
  echo Do NOT load this folder. It is probably a zip with an extra folder layer.
  goto :end
)

<nul set /p "=%DEST%" | clip >nul 2>&1

echo.
echo Done. New folder ^(copied to clipboard^):
echo   %DEST%
echo.
echo Next steps in the browser:
echo   1. Open chrome://extensions ^(Edge: edge://extensions; Firefox: about:debugging^)
echo   2. Remove the old Kesonode
echo   3. Choose "Load unpacked" and paste the copied path
echo.
echo Settings are kept because the extension ID is pinned. Keep the old folder until
echo you have confirmed the new version works.

:end
echo.
pause
endlocal
