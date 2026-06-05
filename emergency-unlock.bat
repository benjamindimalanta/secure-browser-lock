@echo off
REM Opens Brave with extensions disabled so you can reload or remove Browser Lock.
echo Starting Brave with extensions disabled...
start "" "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" --disable-extensions
if errorlevel 1 (
  start "" "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" --disable-extensions
)
echo.
echo In Brave: go to brave://extensions and Reload or Remove "Secure Browser Lock".
pause
