@echo off
REM ============================================================================
REM  Meme Checker - local STAGING bot (OWNER only)
REM
REM  Runs the bot in LIVE mode with real token data.
REM  Stop it with Ctrl+C. Restart with the same command.
REM
REM  This script deliberately does NOT background itself, does NOT auto-restart,
REM  and does NOT stop on error - only one poller may run against the bot token
REM  at a time, or Telegram returns 409 Conflict and both die.
REM ============================================================================

cd /d E:\meme-checker-telegram

if not exist ".env" (
  echo [ERROR] .env not found in %CD%
  echo         The bot cannot start without its configuration.
  pause
  exit /b 1
)

REM Live mode wins over any SCAN_MODE value inside .env (shell env takes priority).
set SCAN_MODE=live

echo ============================================================================
echo  Meme Checker staging bot
echo  Directory : %CD%
echo  Scan mode : live (real market data)
echo  Stop with : Ctrl+C
echo ============================================================================
echo.

node --env-file=.env src/bot.mjs

echo.
echo ============================================================================
echo  Bot stopped (exit code %ERRORLEVEL%).
echo  If this was not Ctrl+C, the reason is printed above.
echo ============================================================================
pause
