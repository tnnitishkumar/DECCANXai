#!/usr/bin/env bash
# Builds the release ZIP from tracked files only (no node_modules, no .env).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
git ls-files -z | xargs -0 zip -q "deccanxai-$VER.zip"
sha256sum "deccanxai-$VER.zip" | tee "deccanxai-$VER.zip.sha256"
