@echo off
REM ==================================================================
REM  One-click build: tag-viewer-electron -> Windows NSIS installer
REM  Same pipeline as electron-wallpaper: electron-builder + npmmirror.
REM  Flow: deps check -> vite build (renderer) -> electron-builder NSIS
REM  After build, run: node tools/prepare-update.cjs  (split + manifests)
REM
REM  NOTE: keep this file pure ASCII. cmd parses .bat as ANSI(GBK) and
REM  UTF-8 CJK comments can swallow line breaks and break the commands.
REM ==================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

where npm >nul 2>nul
if errorlevel 1 (
  echo [FAILED] npm not found in PATH. Install Node.js first.
  pause
  endlocal & exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [INFO] installing dependencies ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [FAILED] npm install failed.
    pause
    endlocal & exit /b 1
  )
)

echo [INFO] building renderer (vite) ...
call npm run build
if errorlevel 1 (
  echo [FAILED] vite build failed.
  pause
  endlocal & exit /b 1
)

call npm run dist -- %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [OK] build finished. Installer in dist\ folder.
  echo Next: npm run update:prepare  to split it for Gitee Release.
  explorer dist
) else (
  echo [FAILED] exit code %RC%
)
pause
endlocal & exit /b %RC%
