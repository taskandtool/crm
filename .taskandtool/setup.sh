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
#   3. installs tt-crawl (the site reader the brand skill fills brand/ and
#      public/ with, for the proposal's components) and its browsers, and
#      Pillow (scripts/proposal-photo.mjs sizes the photographs with it)
#   4. registers the `web` service (`npm run dev`) so the CRM runs in dev on
#      the machine's URL, or restarts it after a replacement
#   5. schedules the automatic texts' job (src/phone-job.ts) every 15
#      minutes, once: the phone skill's follow-ups, by email until Twilio is
#      connected
#
# The database is not this script's business: the platform grants
# DATABASE_URL, and the server waits for it and sets up its tables when it
# appears.
set -euo pipefail

APP="$(pwd)"
CRAWLER_REF="${CRAWLER_REF:-main}"
CRAWLER="git+https://github.com/taskandtool/crawler@$CRAWLER_REF"
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

# 3. tt-crawl, as the other Starter Apps install it: the crawler's main every
# run (the second install replaces its own code even when its version did
# not move), then the browsers it reads sites with. A failure here leaves the
# CRM working; only reading a site waits for it.
echo "== tt-crawl $CRAWLER_REF"
python3 -m pip install --quiet --upgrade "ttcrawl @ $CRAWLER" 2>&1 | tail -1 || true
python3 -m pip install --quiet --force-reinstall --no-deps "ttcrawl @ $CRAWLER" 2>&1 | tail -1 || true
python3 -m ttcrawl setup || echo "tt-crawl setup did not finish every step; its output above says which"
tt-crawl --version || echo "== warning: tt-crawl is not on the PATH; the brand skill cannot read a site until bash .taskandtool/setup.sh runs clean"
python3 -c "import PIL" 2>/dev/null || python3 -m pip install --quiet pillow 2>&1 | tail -1 || echo "== warning: Pillow did not install; scripts/proposal-photo.mjs needs it"

# 4. The web service. `npm run dev` rebuilds the CSS and restarts the server
# on every change; the server applies schema.sql once DATABASE_URL is in
# /home/sprite/.env, which the service sources at start. This is what the
# manifest's `ready` check looks for, so a failure here is the one outcome
# worth exiting non-zero for.
if [ -f "$HOME/tools/taskandtool.py" ]; then
  echo "== serving dev (npm run dev on port 3000)"
  python3 "$HOME/tools/taskandtool.py" serve "npm run dev" --port 3000
fi

# 5. The automatic texts' job: scheduled once, so a form's follow-ups go (by
# email until Twilio is connected) from the first day. Never fatal.
# Matched by its command, so a job the owner renamed is not made again; when
# the jobs can't be listed, nothing is scheduled (the next run tries again).
if [ -f "$HOME/tools/taskandtool.py" ]; then
  if jobs=$(python3 "$HOME/tools/taskandtool.py" list-jobs --json 2>/dev/null); then
    if ! printf '%s' "$jobs" | grep -q "src/phone-job.ts"; then
      echo "== scheduling the automatic texts"
      python3 "$HOME/tools/taskandtool.py" schedule-job "Automatic texts" --when "*/15 * * * *" --command "npx tsx src/phone-job.ts" --team-only \
        || echo "== warning: the automatic texts' job is not scheduled; run this script again"
    fi
  else
    echo "== warning: couldn't list the jobs, so the automatic texts' job waits for the next run of this script"
  fi
fi

echo "== crm starter app setup done"
