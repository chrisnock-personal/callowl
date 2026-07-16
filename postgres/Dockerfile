# ─────────────────────────────────────────────────────────────────────────────
# Extends the stock postgres:16-alpine image with pgBackRest, for continuous
# WAL archiving to MinIO (point-in-time recovery — see DISASTER_RECOVERY.md
# and docker-compose.yml's db service). pgbackrest is a plain Alpine
# community-repo package (`apk add pgbackrest`), no extra repo setup needed,
# same as this project's other from-package installs (backend/Dockerfile's
# python3/paramiko for custom remote-source scripts).
# ─────────────────────────────────────────────────────────────────────────────
FROM postgres:16-alpine

RUN apk add --no-cache pgbackrest

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY docker-entrypoint-wrapper.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint-wrapper.sh

ENTRYPOINT ["docker-entrypoint-wrapper.sh"]
CMD ["postgres"]
