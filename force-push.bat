@echo off
REM ===========================================================================
REM force-push.bat -- overwrite the remote with our local main branch.
REM
REM For a brand-new solo repo: GitHub auto-created an initial commit (likely
REM a README/.gitignore/license) that our local main doesn't share history
REM with. We just overwrite it.
REM ===========================================================================
setlocal
cd /d "%~dp0"

REM Fetch first so any future force-with-lease run has fresh ref info.
git fetch origin

REM Plain --force: brand-new solo repo, no collaborators, no history to keep.
git push --force origin main

echo.
echo If the push above succeeded, your project is now at:
echo   https://github.com/saic97/sbg-tracker
echo.
echo Workflows should fire under the Actions tab. To enable Pages:
echo   Settings -^> Pages -^> Source: GitHub Actions
pause
