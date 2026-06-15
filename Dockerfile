# Clawdot relay + hosted web app, in one image. The relay forwards ciphertext
# and serves the static web build; TLS comes from whatever fronts the
# container — Dokploy/Traefik, Caddy, etc.
# Route the domain to container port 9700; websockets pass through as-is.
#
#   docker build -t clawdot-relay .
#   docker run -p 9700:9700 clawdot-relay

FROM node:22-alpine AS build
WORKDIR /src
# packageManager in package.json pins the pnpm version corepack activates
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY assets ./assets
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @clawdot/relay build \
  && pnpm --filter @clawdot/web build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/apps/relay/dist/index.js ./relay/index.js
COPY --from=build /src/apps/web/dist ./web
# Everything below is runtime configuration — override any of it in the
# deployment platform's environment settings (e.g. Dokploy's Environment tab)
# instead of editing this file. STATIC_DIR="" disables web app hosting.
#
# Push notifications (optional): set FCM_SERVICE_ACCOUNT_JSON to the contents
# of a Firebase service-account key, OR FCM_SERVICE_ACCOUNT_FILE to a path you
# mount it at. FCM_PROJECT_ID overrides the project in that JSON. Leave all
# three unset (the default) to run without push — the daemon still works, it
# just can't wake a backgrounded phone. The credential lives only in memory;
# the relay never writes tokens or payloads to disk. See docs/notifications.md.
ENV HOST=0.0.0.0 \
    PORT=9700 \
    STATIC_DIR=/app/web \
    MAX_CLIENTS_PER_ROOM=32 \
    MAX_ROOMS=4096 \
    MAX_PAYLOAD_MB=16 \
    FCM_SERVICE_ACCOUNT_JSON= \
    FCM_SERVICE_ACCOUNT_FILE= \
    FCM_PROJECT_ID=
EXPOSE 9700
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "/app/relay/index.js"]
