#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# --- Python (pyenv + project venv + pinned deps) ---------------------------

export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
if ! command -v pyenv >/dev/null 2>&1; then
  echo "[dev.sh] pyenv is not installed. Install it from https://github.com/pyenv/pyenv before continuing." >&2
  exit 1
fi
eval "$(pyenv init -)"

PY_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.python-version")"
if ! pyenv versions --bare | grep -qx "$PY_VERSION"; then
  echo "[dev.sh] Installing Python $PY_VERSION via pyenv (one-time)..."
  pyenv install "$PY_VERSION"
fi

VENV_DIR="$REPO_ROOT/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "[dev.sh] Creating project venv at $VENV_DIR..."
  pyenv exec python -m venv "$VENV_DIR"
fi
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

# Reinstall Python deps only when pyproject.toml changes.
DEPS_HASH_FILE="$VENV_DIR/.deps-hash"
CURRENT_HASH="$(shasum -a 256 "$REPO_ROOT/pyproject.toml" | awk '{print $1}')"
if [ ! -f "$DEPS_HASH_FILE" ] || [ "$(cat "$DEPS_HASH_FILE")" != "$CURRENT_HASH" ]; then
  echo "[dev.sh] Installing Python requirements into venv..."
  pip install --quiet --upgrade pip
  pip install --quiet -e "$REPO_ROOT[tools,dev]"
  echo "$CURRENT_HASH" > "$DEPS_HASH_FILE"
fi

echo "[dev.sh] Using $(python --version) at $(command -v python)"

# --- Node (nvm + pinned version + web deps) --------------------------------

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if ! command -v nvm >/dev/null 2>&1; then
  echo "[dev.sh] nvm is not installed. Install it from https://github.com/nvm-sh/nvm before continuing." >&2
  exit 1
fi

# Install/select the Node version pinned in .nvmrc (one-time install).
nvm install
nvm use

# Install web deps only when the lockfile changes.
cd "$REPO_ROOT/apps/web"
NODE_DEPS_HASH_FILE="node_modules/.deps-hash"
NODE_CURRENT_HASH="$(shasum -a 256 package-lock.json | awk '{print $1}')"
if [ ! -f "$NODE_DEPS_HASH_FILE" ] || [ "$(cat "$NODE_DEPS_HASH_FILE")" != "$NODE_CURRENT_HASH" ]; then
  echo "[dev.sh] Installing web dependencies (npm install)..."
  npm install
  echo "$NODE_CURRENT_HASH" > "$NODE_DEPS_HASH_FILE"
fi

# --- Run the dev server ----------------------------------------------------

npm run dev
