@echo off
REM Clears stuck Browser Lock data so Brave can open normally again.
set EXT_ID=fcodilfeiffldliajnimedailcppamap
set STORAGE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Local Extension Settings\%EXT_ID%

echo.
echo Secure Browser Lock - reset saved lock state
echo =============================================
echo.
echo This deletes PIN/lock settings saved by the extension.
echo Your extension files in D:\secure\browser-lock are NOT deleted.
echo You will need to set your PIN again after reloading the extension.
echo.

taskkill /IM brave.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

if exist "%STORAGE%" (
  echo Removing: %STORAGE%
  rmdir /s /q "%STORAGE%"
  echo Done - lock state cleared.
) else (
  echo Storage folder not found (already clear).
)

echo.
echo Starting Brave with extensions disabled...
start "" "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" --disable-extensions
if errorlevel 1 start "" "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" --disable-extensions

echo.
echo 1. Go to brave://extensions
echo 2. Reload "Secure Browser Lock"
echo 3. Close Brave fully, then open Brave normally
echo.
pause
