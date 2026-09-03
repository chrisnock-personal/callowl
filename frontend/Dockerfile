# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS build
# See backend/Dockerfile's matching ENV for why — an npm install stalling for
# minutes on a blackholed IPv6 route to registry.npmjs.org, in an environment
# where curl to the same host succeeds instantly, is a real failure mode
# here, not a hypothetical one.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Serve stage ───────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS serve
RUN apk add --no-cache openssl
COPY nginx.conf /etc/nginx/nginx.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker-entrypoint.sh cert-watcher.sh /
RUN chmod +x /docker-entrypoint.sh /cert-watcher.sh
EXPOSE 80 443
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
