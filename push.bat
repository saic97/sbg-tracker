@echo off
REM ===========================================================================
REM push.bat -- one-click initial push to https://github.com/saic97/sbg-tracker
REM
REM What this does:
REM   1. Wipes the broken .git/ folder left over by the build.
REM   2. Runs `git init -b main`, configures the committer.
REM   3. Stages everything, commits.
REM   4. Adds the remote and pushes to main.
REM
REM Before running:
REM   - Make sure the empty repo exists at https://github.com/saic97/sbg-tracker
REM     (Settings -> no README, no .gitignore, no license -- this project has its own).
REM   - Make sure your local git is authenticated to GitHub (Git Credential Manager
REM     usually handles this automatically the first time it sees a github.com URL).
REM ===========================================================================
setlocal

cd /d "%~dp0"

call init-repo.bat https://github.com/saic97/sbg-tracker.git

echo.
echo Done. Check https://github.com/saic97/sbg-tracker for your push.
echo If GitHub Actions did not fire automatically, open the Actions tab in the repo.
pause
