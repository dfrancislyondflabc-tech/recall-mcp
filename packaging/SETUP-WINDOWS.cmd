@echo off
REM Double-click this. It works out where you put this folder, checks that the
REM bundled Node actually runs here, and opens a page with the exact text to paste
REM into Claude's config.
setlocal
cd /d "%~dp0"
echo.
echo   Setting up the Memory server for Claude...
echo.
if not exist "%~dp0runtime\node.exe" (
  echo   ERROR: runtime\node.exe is missing. The zip did not extract completely.
  echo   Extract the WHOLE zip ^(right-click the zip - Extract All^), then run this again.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0packaging\setup-page.mjs"
set RC=%ERRORLEVEL%
echo.
if %RC% NEQ 0 (
  echo   The check FAILED. SETUP.html explains what went wrong.
) else (
  echo   Ready. Opening SETUP.html...
)
start "" "%~dp0SETUP.html"
echo.
pause
