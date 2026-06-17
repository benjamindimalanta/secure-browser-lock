@echo off
setlocal EnableExtensions
title Browser Secure - Reset Lock State

echo.
echo  ============================================================
echo   Browser Secure - Reset Lock State
echo   Clears stuck PIN/lock data, then opens browser safely
echo   Works with: Brave, Edge, Chrome, Chromium
echo  ============================================================
echo.
echo  WARNING: This deletes saved PIN and lock settings.
echo  You will need to set your PIN again in extension Options.
echo  Your extension install is NOT removed.
echo.
echo  Choose your browser:
echo    1 = Brave
echo    2 = Microsoft Edge
echo    3 = Google Chrome
echo    4 = Chromium (generic)
echo    0 = Cancel
echo.
set /p CHOICE="Enter number (1-4): "

if "%CHOICE%"=="0" exit /b 0
if "%CHOICE%"=="1" (
  set "BROWSER=Brave"
  set "PROC=brave.exe"
  set "USER_DATA=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data"
  set "EXE1=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
  set "EXE2=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
  set "EXT_URL=brave://extensions"
  goto :run
)
if "%CHOICE%"=="2" (
  set "BROWSER=Edge"
  set "PROC=msedge.exe"
  set "USER_DATA=%LOCALAPPDATA%\Microsoft\Edge\User Data"
  set "EXE1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  set "EXE2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  set "EXT_URL=edge://extensions"
  goto :run
)
if "%CHOICE%"=="3" (
  set "BROWSER=Chrome"
  set "PROC=chrome.exe"
  set "USER_DATA=%LOCALAPPDATA%\Google\Chrome\User Data"
  set "EXE1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  set "EXE2=%LocalAppData%\Google\Chrome\Application\chrome.exe"
  set "EXT_URL=chrome://extensions"
  goto :run
)
if "%CHOICE%"=="4" (
  set "BROWSER=Chromium"
  set "PROC=chrome.exe"
  set "USER_DATA=%LOCALAPPDATA%\Chromium\User Data"
  set "EXE1=%LocalAppData%\Chromium\Application\chrome.exe"
  set "EXE2=%ProgramFiles%\Chromium\Application\chrome.exe"
  set "EXT_URL=chrome://extensions"
  goto :run
)
echo Invalid choice.
pause
exit /b 1

:run
echo.
echo Closing %BROWSER%...
taskkill /IM %PROC% /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo.
echo Clearing Browser Secure extension storage...
powershell -NoProfile -ExecutionPolicy Bypass -Command "& {$u='%USER_DATA%';$s='mpfabjdjjeiegkchlcmhfmjogkfpcike';$r=0;if(-not(Test-Path -LiteralPath $u)){Write-Host 'User Data not found:' $u;exit};$ids=[System.Collections.Generic.HashSet[string]]::new();[void]$ids.Add($s);Get-ChildItem -LiteralPath $u -Directory|%%{ $p=Join-Path $_.FullName 'Secure Preferences';if(Test-Path -LiteralPath $p){try{$raw=Get-Content -LiteralPath $p -Raw -Encoding UTF8;if($raw -match 'Browser Secure'){$j=$raw|ConvertFrom-Json;if($j.extensions.settings){$j.extensions.settings.PSObject.Properties|%%{if($_.Value.manifest.name -eq 'Browser Secure'){[void]$ids.Add($_.Name)}}}}}catch{}}};foreach($id in $ids){Get-ChildItem -LiteralPath $u -Directory|%%{ $st=Join-Path $_.FullName ('Local Extension Settings\'+$id);if(Test-Path -LiteralPath $st){Write-Host ('Removing: '+$st);Remove-Item -LiteralPath $st -Recurse -Force -EA SilentlyContinue;$r++}}}};if($r -eq 0){Write-Host 'No storage folders found (may already be clear).'}else{Write-Host ('Cleared '+$r+' folder(s).')}}"

echo.
echo Starting %BROWSER% with extensions disabled...
if exist "%EXE1%" (
  start "" "%EXE1%" --disable-extensions
  goto :finish
)
if exist "%EXE2%" (
  start "" "%EXE2%" --disable-extensions
  goto :finish
)
echo Browser executable not found.
pause
exit /b 1

:finish
echo.
echo  Next steps:
echo  1. Open: %EXT_URL%
echo  2. Reload "Browser Secure"
echo  3. Open extension Options and set a new PIN
echo  4. Close browser fully, then open normally
echo.
echo  More help: https://secure.cubescenter.org/recovery
echo.
pause
exit /b 0
