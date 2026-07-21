#!/usr/bin/env bash
# ─── CallOwl — Sync & Deploy Script ──────────────────────────────────────────
# Syncs local source changes to a remote host (e.g. a VPS) and rebuilds/
# restarts the podman-compose stack there. Mirrors the sync.sh pattern from
# open-event-aggregator, adapted for this project's multi-service compose
# stack (db/backend/frontend/backup) instead of a single supervisord image.
#
# Usage:
#   ./sync.sh user@host          # sync + rebuild + restart
#   ./sync.sh --sync-only        # sync files only, no rebuild
#   ./sync.sh --rebuild-only     # rebuild without syncing
#   ./sync.sh --logs             # tail backend logs after deploy
#
#   Set OPENCDR_REMOTE=user@host to avoid passing it every time
#   Set OPENCDR_REMOTE_DIR=path  to change the remote checkout path

set -e

# ─── Config ───────────────────────────────────────────────────────────────────
REMOTE_HOST="${OPENCDR_REMOTE:-}"
# Default intentionally left pointing at the existing remote deployment's
# actual path, not renamed to match the local CallOwl rebrand — this is
# where the real, already-running production checkout lives.
REMOTE_DIR="${OPENCDR_REMOTE_DIR:-~/Apps/open-cdr-platform}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Arg parsing ─────────────────────────────────────────────────────────────
SYNC_ONLY=false
REBUILD_ONLY=false
SHOW_LOGS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --sync-only)    SYNC_ONLY=true ;;
    --rebuild-only) REBUILD_ONLY=true ;;
    --logs)         SHOW_LOGS=true ;;
    --help|-h)
      echo "Usage: ./sync.sh user@host [options]"
      echo ""
      echo "  user@host          Remote host to deploy to (or set OPENCDR_REMOTE)"
      echo "  --sync-only        Sync files only, skip rebuild"
      echo "  --rebuild-only     Rebuild on remote without syncing"
      echo "  --logs             Tail backend logs after deploy"
      echo ""
      echo "  Set OPENCDR_REMOTE=user@host to change the default remote"
      echo "  Set OPENCDR_REMOTE_DIR=path  to change the remote checkout path (default: $REMOTE_DIR)"
      exit 0
      ;;
    *@*)            REMOTE_HOST="$1" ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "$REMOTE_HOST" ]; then
  echo "❌  No remote host set. Pass user@host, or set OPENCDR_REMOTE." >&2
  exit 1
fi

echo "📡  CallOwl Sync & Deploy"
echo "    Local:  $LOCAL_DIR"
echo "    Remote: $REMOTE_HOST:$REMOTE_DIR"
echo ""

# ─── Sync ─────────────────────────────────────────────────────────────────────
if [ "$REBUILD_ONLY" = false ]; then
  # rsync will create the final leaf directory itself but not missing parents
  # (e.g. a not-yet-existing ~/Apps on a fresh VPS) — make sure the whole path
  # exists first rather than failing with "No such file or directory".
  ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

  echo "📦  Syncing source files..."

  # --filter=':- .gitignore' already covers node_modules/dist/.env/backups —
  # the explicit excludes are defensive redundancy, same as the reference
  # script. .env is never synced either direction: the remote's own
  # production secrets (ADMIN_API_KEY etc.) must never be overwritten by
  # whatever's (or isn't) in the local dev .env.
  rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude '.git' \
    --exclude '*.log' \
    --exclude '.env' \
    --exclude 'backups/' \
    --filter=':- .gitignore' \
    "$LOCAL_DIR/" \
    "$REMOTE_HOST:$REMOTE_DIR/"

  echo "✓  Sync complete"
  echo ""
fi

# ─── Rebuild ──────────────────────────────────────────────────────────────────
if [ "$SYNC_ONLY" = false ]; then
  echo "🔨  Building and restarting on $REMOTE_HOST..."
  echo ""

  ssh "$REMOTE_HOST" bash << EOF
    set -e
    cd $REMOTE_DIR

    echo "→ Building images (--no-cache — this stack has served stale cached layers before)..."
    podman-compose build --no-cache backend frontend

    echo "→ Recreating containers..."
    # frontend depends_on backend, so removing backend first can fail with
    # "has dependent containers" — remove frontend first, backend second,
    # each tolerant of failure (podman-compose up -d recreates whatever's
    # actually missing regardless).
    podman rm -f callowl-frontend 2>/dev/null || true
    podman rm -f callowl-backend 2>/dev/null || true
    podman-compose up -d

    echo ""
    echo "→ Waiting for startup..."
    sleep 5

    echo ""
    echo "─── Startup logs ────────────────────────────────────────────────"
    podman logs --tail 20 callowl-backend
    echo "─────────────────────────────────────────────────────────────────"
    echo ""
    echo "✅  Deploy complete"
    HTTP_PORT_VAL="\$(grep -E '^HTTP_PORT=' .env 2>/dev/null | cut -d= -f2)"
    echo "    UI: http://\$(hostname -I | awk '{print \$1}'):\${HTTP_PORT_VAL:-8080}"
EOF

  echo ""
fi

# ─── Logs ─────────────────────────────────────────────────────────────────────
if [ "$SHOW_LOGS" = true ]; then
  echo "📋  Tailing backend logs (Ctrl+C to stop)..."
  echo ""
  ssh -t "$REMOTE_HOST" "podman logs -f callowl-backend"
fi
