@echo off
setlocal EnableExtensions
title Browser Secure - Emergency Unlock

echo.
echo  ============================================================
echo   Browser Secure - Emergency Unlock
echo   Opens your browser WITH extensions disabled
echo   Works with: Brave, Edge, Chrome, Chromium
echo  ============================================================
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
if "%CHOICE%"=="1" goto :brave
if "%CHOICE%"=="2" goto :edge
if "%CHOICE%"=="3" goto :chrome
if "%CHOICE%"=="4" goto :chromium
echo Invalid choice.
pause
exit /b 1

:brave
echo.
echo Closing Brave if running...
taskkill /IM brave.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
echo Starting Brave with extensions disabled...
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
  start "" "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" --disable-extensions
  goto :done
)
if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" (
  start "" "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" --disable-extensions
  goto :done
)
echo Brave not found. Install Brave or pick another browser.
pause
exit /b 1

:edge
echo.
echo Closing Edge if running...
taskkill /IM msedge.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
echo Starting Edge with extensions disabled...
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --disable-extensions
  goto :done
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --disable-extensions
  goto :done
)
echo Edge not found.
pause
exit /b 1

:chrome
echo.
echo Closing Chrome if running...
taskkill /IM chrome.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
echo Starting Chrome with extensions disabled...
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --disable-extensions
  goto :done
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" --disable-extensions
  goto :done
)
echo Chrome not found.
pause
exit /b 1

:chromium
echo.
echo Closing Chromium if running...
taskkill /IM chrome.exe /F >nul 2>&1
taskkill /IM chromium.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
echo Starting Chromium with extensions disabled...
if exist "%LocalAppData%\Chromium\Application\chrome.exe" (
  start "" "%LocalAppData%\Chromium\Application\chrome.exe" --disable-extensions
  goto :done
)
if exist "%ProgramFiles%\Chromium\Application\chrome.exe" (
  start "" "%ProgramFiles%\Chromium\Application\chrome.exe" --disable-extensions
  goto :done
)
echo Chromium not found. Try Google Chrome option instead.
pause
exit /b 1

:done
echo.
echo  Next steps:
echo  1. Go to your browser extensions page:
echo       Brave:  brave://extensions
echo       Edge:   edge://extensions
echo       Chrome: chrome://extensions
echo  2. Find "Browser Secure" and click Reload
echo  3. Close the browser fully, then open it normally
echo.
echo  If the browser still closes instantly, run reset-lock-state.bat
echo  Download: https://secure.cubescenter.org/recovery
echo.
pause
exit /b 0
