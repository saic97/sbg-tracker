@echo off
REM ============================================================================
REM init-repo.bat -- one-shot initializer for the SBG Tracker project on Windows.
REM Wipes any partial .git/ directory left over by the build, runs git init,
REM stages everything, and creates the first commit. Then adds the remote and
REM pushes IF you pass a repo URL as the first argument.
REM
REM Usage:
REM     init-repo.bat                           (init + commit only)
REM     init-repo.bat https://github.com/USER/REPO.git   (init + push)
REM ============================================================================
setlocal

if exist .git (
  echo Removing existing .git directory...
  rmdir /s /q .git
)

git init -b main || (echo git init failed & exit /b 1)

git config user.email "estimates@sourcebuild.net"
git config user.name "Source Building Group"

git add -A
git commit -m "Initial import: SBG Preconstruction Bid Tracker (full-stack rebuild)"

if not "%~1"=="" (
  echo Adding remote origin: %~1
  git remote add origin %~1
  git push -u origin main
) else (
  echo.
  echo No remote URL supplied. Run again as:  init-repo.bat https://github.com/USER/REPO.git
  echo Or push manually:
  echo     git remote add origin https://github.com/USER/REPO.git
  echo     git push -u origin main
)
