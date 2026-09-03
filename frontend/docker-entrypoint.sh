#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Two jobs before nginx can start, since nginx.conf's 443 listener needs a
# certificate to exist and its 80→443 redirect needs to know the real
# external HTTPS port:
#
#   1. Generate a self-signed TLS cert on whichever boot first finds none
#      present, then leave it alone on every boot after that. CERT_DIR is
#      backed by its own named volume (docker-compose.yml) specifically so a
#      routine container recreate doesn't silently mint a new cert (which
#      wouldn't break anything functional, but would re-trip the "not
#      trusted" browser warning for no reason). Replace it with a real
#      PKI-issued one any time by mounting server.crt/server.key over this
#      same path — see README's Deploying section.
#   2. Render nginx.conf's __HTTPS_PORT__ placeholder from $HTTPS_PORT — see
#      nginx.conf for why this is a plain sed rather than nginx's own
#      envsubst templating.
#
# Also starts cert-watcher.sh in the background before exec'ing nginx as the
# container's main process — it's what actually applies a certificate
# uploaded via the dashboard's admin-UI TLS panel (POST /admin/tls), since
# the backend container that receives that upload has no nginx of its own to
# validate/reload against. See cert-watcher.sh for the swap/validate/
# reload/rollback sequence.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

CERT_DIR="/etc/nginx/certs"
mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/server.crt" ] || [ ! -f "$CERT_DIR/server.key" ]; then
  echo "[entrypoint] No TLS certificate found — generating a self-signed one (persisted from now on)..."
  SAN="DNS:localhost,IP:127.0.0.1"
  [ -n "${CALLOWL_HOST_NAME:-}" ] && SAN="$SAN,DNS:${CALLOWL_HOST_NAME}"
  [ -n "${CALLOWL_HOST_IP:-}" ] && SAN="$SAN,IP:${CALLOWL_HOST_IP}"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" \
    -days 3650 -subj "/CN=callowl" \
    -addext "subjectAltName=$SAN"
  chmod 600 "$CERT_DIR/server.key"
  chmod 644 "$CERT_DIR/server.crt"
  echo "[entrypoint] Self-signed certificate generated: $CERT_DIR/server.crt"
else
  echo "[entrypoint] Existing TLS certificate found in $CERT_DIR — leaving it as-is"
fi

sed "s/__HTTPS_PORT__/${HTTPS_PORT:-8443}/g" /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf

/cert-watcher.sh &

exec "$@"
