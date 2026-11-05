# AllGLANCE gateway image.
#
# Multi-stage: build/install deps, then run. A headless Chromium for the legacy
# Playwright reader is opt-in (--build-arg INSTALL_BROWSER=true); by default the
# image is small and reads app data from the shared sync snapshots.
#
# Build:  docker build -t allglance/gateway ./gateway
# Run:    via docker compose up --build (see top-level docker-compose.yml)

FROM node:22-bookworm AS deps
WORKDIR /app

# Enable pnpm via corepack (bundled with node:22).
ENV COREPACK_ENABLED=true
# Optional extra CA for builds behind a TLS-intercepting proxy: pass it as the
# build secret `extra_ca` (see docker/compose.proxy-ca.yml). Absent = no effect.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@9 --activate

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --prod --frozen-lockfile

# OPTIONAL headless browser for the legacy Playwright fallback reader. Off by
# default: lastGLANCE/lifeGLANCE data is read from their synced snapshots
# (GLANCE_SYNC_DIR) and dayGLANCE over MCP, and the browser reader cannot see
# their IndexedDB data anyway. Enable with: --build-arg INSTALL_BROWSER=true
ARG INSTALL_BROWSER=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN --mount=type=secret,id=extra_ca,required=false \
    mkdir -p /ms-playwright; \
    if [ "$INSTALL_BROWSER" = "true" ]; then \
      if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
      npx playwright install --with-deps chromium; \
    fi

# ---- Runtime ----
FROM node:22-bookworm
ENV NODE_ENV=production
WORKDIR /app

# Chromium for the Playwright reader: browser binaries from the deps stage plus
# the OS libraries they need (installed here, since --with-deps only touched the
# deps stage's filesystem).
ARG INSTALL_BROWSER=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=deps /ms-playwright /ms-playwright
COPY --from=deps /app/node_modules ./node_modules
RUN if [ "$INSTALL_BROWSER" = "true" ]; then npx playwright install-deps chromium && rm -rf /var/lib/apt/lists/*; fi

# Non-root user.
RUN groupadd -r allglance && useradd -r -g allglance -d /app allglance

COPY . .

# Config + runtime data (roster cache, MCP session state) lives here.
ENV GATEWAY_HOST=0.0.0.0
EXPOSE 8090

USER allglance
CMD ["node", "src/server.js"]
