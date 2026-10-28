#!/usr/bin/env bash
# Run the README quick start ("Without Docker, run from a checkout") on a fresh install.
#
# 1. A fresh clone of this checkout, `npm install`, `npm run build`, then every server is
#    started over stdio the way `claude mcp add <name> -- node .../dist/index.js` would
#    start it; each must list its tools, and decode_jwt must give the README sample.
# 2. `npm pack` of jwt-tools, installed into an empty project, started through its
#    `mcp-jwt-tools` bin.
#
#   scripts/e2e-quickstart.sh        (npm run e2e)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== From a fresh clone"
git clone --quiet "$repo" "$work/clone"
cd "$work/clone"
npm install --no-audit --no-fund --silent
npm run --silent build
node scripts/e2e-stdio.mjs --all packages

echo "== From the packed jwt-tools tarball"
tarball="$(cd packages/jwt-tools && npm pack --silent --pack-destination "$work" | tail -1)"
mkdir "$work/project"
cd "$work/project"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$work/$tarball"
node "$work/clone/scripts/e2e-stdio.mjs" "$work/project/node_modules/.bin/mcp-jwt-tools"

echo "quick start OK on a fresh install"
