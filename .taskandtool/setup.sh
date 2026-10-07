#!/usr/bin/env bash
# CRM Starter App setup. Task & Tool runs this in ~/app after the repository
# is cloned onto the machine, and again whenever the machine is replaced.
# Safe to re-run any time:
#
#     bash ~/app/.taskandtool/setup.sh
#
# What it does, each step skipped when already done:
#   1. makes sure the working copy is a git repo with a commit in it
#   2. installs the npm dependencies (which vendors htmx and SortableJS) and
#      builds the CSS once
#   3. registers the `web` service (`npm run dev`) so the CRM runs in dev on
#      the machine's URL, or restarts it after a replacement
#
# The database is not this script's business: the platform grants
# DATABASE_URL, and the server waits for it and sets up its tables when it
# appears.
set -euo pipefail

APP="$(pwd)"
echo "== crm starter app: setup in $APP"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "node and npm are required (Node 20 or newer); install them and re-run" >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  echo "Node $(node --version) found; the CRM needs Node 20 or newer (nvm install 22)" >&2
  exit 1
fi

# 1. Git: the CRM is the owner's repo from the first minute.
if [ ! -d .git ]; then
  git init -q
fi
if ! git rev-parse --verify HEAD >/dev/null 2>&1 && [ -f package.json ]; then
  git add -A
  git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo 'Task & Tool')}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo 'crm@taskandtool.app')}" \
      commit -q -m "CRM Starter App" && echo "== first commit made"
fi

# 2. Dependencies (postinstall copies the client libraries into static/vendor)
# and the first CSS build.
echo "== npm install"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
echo "== building the CSS"
npm run --silent css

# 3. The web service. `npm run dev` rebuilds the CSS and restarts the server
# on every change; the server applies schema.sql once DATABASE_URL is in
# /home/sprite/.env, which the service sources at start. This is what the
# manifest's `ready` check looks for, so a failure here is the one outcome
# worth exiting non-zero for.
if [ -f "$HOME/tools/taskandtool.py" ]; then
  echo "== serving dev (npm run dev on port 3000)"
  python3 "$HOME/tools/taskandtool.py" serve "npm run dev" --port 3000
fi

echo "== crm starter app setup done"
