@echo off
setlocal
cd /d "%~dp0\.."
echo Releasing POS + Manager Portal + Owner Console to production...
echo.
call node scripts\release-all.js
echo.
if %ERRORLEVEL% NEQ 0 (
  echo *** Release failed - see the error above. ***
) else (
  echo *** Done. ***
)
pause
