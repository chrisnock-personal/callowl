#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Backs the admin-UI cert replace flow (POST /admin/tls, backend/src/db/tlsCert.ts).
# The backend container has no nginx of its own to `nginx -t`/reload against —
# it shares this container's certs volume and can only stage a new pair as
# pending.crt/pending.key. This loop is the other half: swap the pending pair
# in, validate with the real nginx binary, reload on success or roll back on
# failure, and report the outcome back via .cert-reload-status (same
# "<UTC timestamp> ok|failed" convention scripts/backup.sh's .last-attempt
# uses, plus a reason line on failure) for the backend to poll.
#
# Started as a background process by docker-entrypoint.sh, before it execs
# nginx as the container's main process — not `set -e`, deliberately: this
# runs for the container's whole lifetime, and one bad iteration (a cp racing
# a concurrent request, say) shouldn't take the whole watcher down with it.
# ─────────────────────────────────────────────────────────────────────────────
set -u

CERT_DIR="/etc/nginx/certs"
STATUS_FILE="$CERT_DIR/.cert-reload-status"

while true; do
  if [ -f "$CERT_DIR/pending.crt" ] && [ -f "$CERT_DIR/pending.key" ]; then
    ERR_FILE="/tmp/nginx-test-err.$$"
    cp "$CERT_DIR/server.crt" "$CERT_DIR/server.crt.bak" 2>/dev/null
    cp "$CERT_DIR/server.key" "$CERT_DIR/server.key.bak" 2>/dev/null
    mv "$CERT_DIR/pending.crt" "$CERT_DIR/server.crt"
    mv "$CERT_DIR/pending.key" "$CERT_DIR/server.key"
    chmod 644 "$CERT_DIR/server.crt"
    chmod 600 "$CERT_DIR/server.key"

    if nginx -t 2>"$ERR_FILE" && nginx -s reload; then
      echo "$(date -u +%FT%TZ) ok" > "$STATUS_FILE"
    else
      REASON=$(tr '\n' ' ' < "$ERR_FILE" | cut -c1-500)
      mv "$CERT_DIR/server.crt.bak" "$CERT_DIR/server.crt" 2>/dev/null
      mv "$CERT_DIR/server.key.bak" "$CERT_DIR/server.key" 2>/dev/null
      printf '%s failed\n%s\n' "$(date -u +%FT%TZ)" "$REASON" > "$STATUS_FILE"
    fi
    rm -f "$CERT_DIR/server.crt.bak" "$CERT_DIR/server.key.bak" "$ERR_FILE"
  fi
  sleep 2
done
