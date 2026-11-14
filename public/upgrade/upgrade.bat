@echo off
rem Kesonode one-click upgrade helper (Windows 10 or newer).
rem A browser extension cannot replace its own files. This script unpacks the downloaded
rem zip into ONE folder named Kesonode, so the path never changes and the extension ID —
rem and with it every setting — survives the upgrade. The previous folder is kept as
rem Kesonode.old-<timestamp> instead of being deleted.
rem English only on purpose: console output must stay readable under any OEM code page.
rem
rem Usage: upgrade.bat [package.zip] [target folder]
rem   target folder defaults to %USERPROFILE%\Downloads\Kesonode
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

set "TARGET=%~2"
if not defined TARGET set "TARGET=%USERPROFILE%\Downloads\Kesonode"

for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%T"
if not defined STAMP set "STAMP=%RANDOM%"

set "STAGE=%TEMP%\kesonode-upgrade-%STAMP%"
mkdir "%STAGE%" 2>nul
if errorlevel 1 (
  echo Cannot create the temporary folder %STAGE%
  goto :end
)

echo Unpacking ...
tar -xf "%ZIP%" -C "%STAGE%" 2>nul
if errorlevel 1 (
  echo Unpacking failed. Windows 10 or newer is required, or unzip the package manually.
  goto :clean
)

rem Two layouts: a release package puts everything inside one Kesonode folder, a store
rem package has its files at the root. Both have to be recognised.
set "ROOT="
if exist "%STAGE%\manifest.json" set "ROOT=%STAGE%"
if not defined ROOT (
  for /d %%D in ("%STAGE%\*") do (
    if exist "%%~fD\manifest.json" if not defined ROOT set "ROOT=%%~fD"
  )
)
if not defined ROOT (
  echo manifest.json was not found in the unpacked package.
  echo This does not look like a Kesonode package. Download it again.
  goto :clean
)

rem The previous folder is renamed, never deleted: this is the one step that touches the
rem user's files, and keeping it means a bad release can be undone by hand.
if exist "%TARGET%" (
  set "OLD=%TARGET%.old-%STAMP%"
  move "%TARGET%" "%OLD%" >nul 2>&1
  if exist "%TARGET%" (
    echo Cannot move the old folder %TARGET% aside. Nothing was changed.
    goto :clean
  )
  echo Old folder kept as: %OLD%
)

mkdir "%TARGET%" 2>nul
xcopy "%ROOT%\*" "%TARGET%\" /E /I /H /Y /Q >nul
if errorlevel 1 (
  echo Copying into %TARGET% failed.
  goto :clean
)
if not exist "%TARGET%\manifest.json" (
  echo manifest.json was not copied. Nothing usable was installed.
  goto :clean
)

<nul set /p "=%TARGET%" | clip >nul 2>&1

echo.
echo Done. Folder ^(copied to clipboard^):
echo   %TARGET%
echo.
echo Next steps in the browser:
echo   1. Open chrome://extensions ^(Edge: edge://extensions; Firefox: about:debugging^)
echo   2. Press "Reload" on Kesonode; if it is not loaded from this folder, choose
echo      "Load unpacked" and paste the copied path
echo.
echo The folder name never changes, so the extension ID and all your settings are kept.
echo Keep the .old- folder until you have confirmed the new version works.

:clean
if defined STAGE rmdir /s /q "%STAGE%" >nul 2>&1

:end
echo.
pause
endlocal
