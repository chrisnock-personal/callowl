#!/bin/sh
# Runs as root (the container's default user) so it can fix up ownership of
# the ./backups bind mount, and the certs named volume (shared with
# `frontend` — see db/tlsCert.ts), before dropping to the non-root `node`
# user to actually run the app. Mount ownership is only known at container
# start (whatever the host path is chowned to, or whatever a fresh named
# volume defaults to — root, for `certs`), and under rootless Podman's
# default user namespace remapping it doesn't line up with `node`'s uid even
# when both host and container report uid 1000 — so this can't be done once
# at build time in the Dockerfile.
set -e
chown -R node:node /app/backups 2>/dev/null || true
chown -R node:node /app/certs 2>/dev/null || true
exec su -s /bin/sh node -c "$*"
