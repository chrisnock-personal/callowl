# pgBackRest's S3 driver always speaks TLS (repo1-s3-verify-tls=n only skips
# certificate verification, it doesn't drop encryption) — so MinIO needs a
# cert even for this internal-only, self-hosted use. The base minio/minio
# image is RHEL UBI-minimal with no package manager and no openssl, so the
# cert is generated in a throwaway Alpine build stage and copied in — baked
# in at build time rather than generated at container startup specifically
# to avoid needing a separate one-shot compose service (podman-compose's pod
# dependency tracking doesn't handle a `restart: "no"` one-shot dependency
# reliably here). Self-signed and build-time-static is fine: this cert's
# only job is satisfying "TLS handshake happened," verified by nobody but
# pgBackRest/mc with verify-tls disabled, and never leaves the compose network.
FROM alpine:latest AS certgen
RUN apk add --no-cache openssl && \
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout /private.key -out /public.crt \
      -subj "/CN=minio" -addext "subjectAltName=DNS:minio"

FROM minio/minio:latest
COPY --from=certgen /public.crt /root/.minio/certs/public.crt
COPY --from=certgen /private.key /root/.minio/certs/private.key
