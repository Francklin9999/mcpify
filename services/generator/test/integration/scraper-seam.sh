#!/usr/bin/env bash
# Proves the real Node<->Python seam: start the uvicorn scraper + a static page server, then have the
# Node HttpScraper adapter call /capture and validate the cross-language CaptureBundle.
set -euo pipefail
cd "$(dirname "$0")/../../../.."   # repo root

PAGEPORT=58081
SCRAPERPORT=58090
PAGEDIR="$(mktemp -d)"
cat > "$PAGEDIR/index.html" <<'HTML'
<!doctype html><html><head><title>Seam Page</title></head>
<body><h1>Seam test</h1><p>This is a fully server-rendered static page with enough visible text content
that the scraper's tier-1 fast path is sufficient and no browser is needed for this cross-process check.</p>
</body></html>
HTML

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" >/dev/null 2>&1 || true; done; rm -rf "$PAGEDIR"; }
trap cleanup EXIT

python3 -m http.server "$PAGEPORT" --directory "$PAGEDIR" >/dev/null 2>&1 & PIDS+=($!)
( cd services/scraper && .venv/bin/uvicorn scraper.service:app --host 127.0.0.1 --port "$SCRAPERPORT" >/dev/null 2>&1 ) & PIDS+=($!)

echo "=== waiting for scraper /healthz ==="
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$SCRAPERPORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

npm run build --workspace=@mcp/generator >/dev/null
echo "=== running Node->Python seam check ==="
SCRAPER_URL="http://127.0.0.1:$SCRAPERPORT" PAGE_URL="http://127.0.0.1:$PAGEPORT/" \
  node services/generator/test/integration/scraper-seam-check.mjs
