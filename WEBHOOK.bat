@echo off
title Fat Stack - Register Telegram Webhook
color 0D
cd /d "%~dp0"

echo.
echo  =========================================
echo   FAT STACK - register Telegram webhook
echo  =========================================
echo.
echo  Run this AFTER Render has deployed your service and you have:
echo    1. The Render URL (e.g. https://fat-stack.onrender.com)
echo    2. Your Telegram bot token (from @BotFather)
echo.

set /p RENDER_URL=  Render URL (paste the full https:// URL):
if "%RENDER_URL%"=="" (
  echo  ERROR: Render URL is required.
  pause
  exit /b 1
)

set /p BOT_TOKEN=  Bot token (paste from @BotFather):
if "%BOT_TOKEN%"=="" (
  echo  ERROR: Bot token is required.
  pause
  exit /b 1
)

echo.
echo  Hitting %RENDER_URL%/api/setup-webhook ...
echo.

curl -s -X POST "%RENDER_URL%/api/setup-webhook" -H "x-setup-key: %BOT_TOKEN%"

echo.
echo.
echo  Expected: {"webhook_url":"...","telegram":{"ok":true,...}}
echo.
echo  If you see {"ok":true} above, the webhook is LIVE.
echo  Telegram will now deliver pre_checkout_query, successful_payment,
echo  and /start updates to your server.
echo.
echo  Next step: open @BotFather and run /newapp to register the Mini App URL.
echo.
pause
