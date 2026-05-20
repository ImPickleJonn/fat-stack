@echo off
title Fat Stack - Push to GitHub
color 0E
cd /d "%~dp0"

echo.
echo  =========================================
echo   FAT STACK - push to GitHub
echo  =========================================
echo.

REM ---- Check gh is installed + authed ----
where gh >nul 2>nul
if errorlevel 1 (
  echo  ERROR: GitHub CLI (gh) is not installed.
  echo.
  echo  Install it from: https://cli.github.com/
  echo  After install, run: gh auth login
  echo.
  pause
  exit /b 1
)

gh auth status >nul 2>nul
if errorlevel 1 (
  echo  ERROR: You are not logged in to GitHub CLI.
  echo.
  echo  Run this in any terminal first:
  echo      gh auth login
  echo  Then re-run this script.
  echo.
  pause
  exit /b 1
)

REM ---- Check we're inside a git repo ----
if not exist ".git" (
  echo  ERROR: This folder is not a git repo.
  echo  Something is wrong with the project. Stop and ask Claude.
  echo.
  pause
  exit /b 1
)

REM ---- Check if origin already exists ----
git remote get-url origin >nul 2>nul
if not errorlevel 1 (
  echo  Git remote "origin" is already set. Pushing instead of creating...
  echo.
  git push -u origin main
  if errorlevel 1 (
    echo.
    echo  Push failed. Check the error above.
    pause
    exit /b 1
  )
  echo.
  echo  =========================================
  echo   PUSHED. Repo URL:
  for /f "delims=" %%i in ('git remote get-url origin') do echo     %%i
  echo  =========================================
  pause
  exit /b 0
)

echo  Creating GitHub repo "fat-stack" under your account...
echo  (public repo — change PUSH.bat to add --private if you want it private)
echo.

gh repo create fat-stack --public --source=. --remote=origin --push

if errorlevel 1 (
  echo.
  echo  gh repo create failed. Common reasons:
  echo    - A repo named "fat-stack" already exists on your account
  echo    - Network issue
  echo.
  echo  Check the error message above.
  pause
  exit /b 1
)

echo.
echo  =========================================
echo   SUCCESS! Repo is live on GitHub:
for /f "delims=" %%i in ('gh repo view --json url --jq .url') do echo     %%i
echo  =========================================
echo.
echo  Next step: deploy to Render. See DEPLOY.md or chat with Claude.
echo.
pause
