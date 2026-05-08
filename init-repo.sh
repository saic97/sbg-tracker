#!/usr/bin/env bash
# ===========================================================================
# init-repo.sh -- one-shot initializer for the SBG Tracker project (mac/linux).
# Mirror of init-repo.bat. Pass the GitHub repo URL as $1 to also push.
# Usage:
#     ./init-repo.sh
#     ./init-repo.sh https://github.com/USER/REPO.git
# ===========================================================================
set -euo pipefail

if [ -d .git ]; then
  echo "Removing existing .git directory..."
  rm -rf .git
fi

git init -b main
git config user.email "estimates@sourcebuild.net"
git config user.name "Source Building Group"
git add -A
git commit -m "Initial import: SBG Preconstruction Bid Tracker (full-stack rebuild)"

if [ "${1:-}" != "" ]; then
  echo "Adding remote origin: $1"
  git remote add origin "$1"
  git push -u origin main
else
  echo
  echo "No remote URL supplied. Run again as:  ./init-repo.sh https://github.com/USER/REPO.git"
  echo "Or push manually:"
  echo "    git remote add origin https://github.com/USER/REPO.git"
  echo "    git push -u origin main"
fi
