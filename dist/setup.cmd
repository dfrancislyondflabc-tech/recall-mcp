@echo off
REM Memory MCP server - Windows setup.
REM Installs dependencies for THIS machine (native binaries are per-platform,
REM which is exactly why node_modules is not shipped in the zip) and prints the
REM configuration to paste into Claude.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo ERROR: Node.js is not on PATH. Install Node 20+ from https://nodejs.org & exit /b 1)
where git  >nul 2>nul || (echo NOTE: git is not on PATH. The server runs fine, but commit verification is disabled.)

echo Installing dependencies for windows (this fetches the win32 binaries)...
call npm install --omit=dev || (echo npm install failed & exit /b 1)

echo.
echo Building the initial index...
call npm run index || (echo index build failed & exit /b 1)

echo.
echo Verifying the server over stdio...
REM `npm run verify` and NOT `npm test`: the full suite asserts against a populated
REM corpus and cannot pass on a machine that has none yet, which is every new
REM install. This checks what actually matters here - the server starts, speaks
REM MCP, advertises its actions and answers a call.
call npm run verify
if errorlevel 1 (echo VERIFICATION FAILED - do not register this until it passes & exit /b 1)

echo.
echo ==========================================================
echo Add this to your Claude MCP config ("mcpServers"):
echo.
echo   "memory": {
echo     "command": "node",
echo     "args": ["%CD:\=/%/index.js"]
echo   }
echo.
echo Then see INSTALL-WINDOWS.md for the capture hooks.
echo ==========================================================
endlocal
