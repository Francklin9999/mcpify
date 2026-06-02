#!/usr/bin/env bash
# Expose MCP Forge on a public URL.
#
# Runs the full stack locally (Docker Compose) behind nginx on one port, then opens
# a Cloudflare quick tunnel to it. The browser only talks to the web app, so a single
# tunnel exposes the whole system. CORS is fully open, so any origin can call it.
#
#   ./scripts/expose.sh                 # port 8080 + cloudflared
#   PORT=9000 ./scripts/expose.sh       # different port
#   NO_BUILD=1 ./scripts/expose.sh      # skip compose build/up (stack already running)
#
# Ctrl-C stops the tunnel (the Docker stack keeps running; `npm run deploy:down` to stop it).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
PORT="${PORT:-8080}"

# 1. Make sure a tunnel tool exists (auto-install cloudflared to ~/.local/bin, no sudo).
if ! command -v cloudflared >/dev/null 2>&1 && ! command -v ngrok >/dev/null 2>&1; then
  echo "▶ Installing cloudflared to ~/.local/bin …"
  mkdir -p "$HOME/.local/bin"
  arch="$(uname -m)"; case "$arch" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) a=amd64;; esac
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"   # linux / darwin
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${a}" \
    -o "$HOME/.local/bin/cloudflared"
  chmod +x "$HOME/.local/bin/cloudflared"
fi

# 2. Bring the stack up (idempotent) unless told to skip.
if [ "${NO_BUILD:-0}" != "1" ]; then
  if ! docker info >/dev/null 2>&1; then
    echo "✖ Docker daemon isn't running. Start Docker and retry (or use NO_BUILD=1 if it's already up elsewhere)." >&2
    exit 1
  fi
  [ -f .env ] || { [ -f .env.deploy.example ] && cp .env.deploy.example .env && echo "▶ Created .env from .env.deploy.example — add your API keys."; }
  echo "▶ Starting the stack (first build pulls Chromium; can take several minutes)…"
  HTTP_PORT="$PORT" docker compose -f infra/compose.prod.yml up -d --build
fi

# 3. Wait until it answers.
echo "▶ Waiting for http://localhost:$PORT/healthz …"
for _ in $(seq 1 80); do
  curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { echo "  ✔ healthy"; break; }
  sleep 3
done

# 4. Open the public tunnel (prints the https URL; stays in the foreground).
echo "▶ Opening public tunnel — your URL prints below (Ctrl-C to stop):"
if command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel --url "http://localhost:$PORT"
else
  exec ngrok http "$PORT"
fi
