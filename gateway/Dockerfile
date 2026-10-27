# AllGLANCE gateway image.
#
# Multi-stage: install production deps, then run. Playwright's chromium (used by
# the lastglance + lifeglance adapters when the apps run as Docker web builds)
# is installed in the runtime stage, with its OS libraries, at a shared path the
# non-root user can read, so the Playwright reader works out of the box.
#
# Build:  docker build -t allglance/gateway ./gateway
# Run:    via docker compose up --build (see top-level docker-compose.yml)

FROM node:22-bookworm AS deps
WORKDIR /app

# pnpm comes from corepack, at the version pinned in package.json (packageManager).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---- Runtime ----
FROM node:22-bookworm
ENV NODE_ENV=production
# Browsers live outside any home directory so the non-root user can launch them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

# Non-root user.
RUN groupadd -r allglance && useradd -r -g allglance -d /app allglance

COPY --from=deps /app/node_modules ./node_modules

# Headless chromium + the OS libraries it needs, matching the installed
# playwright version. Done here, not in the deps stage, so they ship.
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright

COPY . .

# Config + runtime data (roster cache, MCP session state) lives here.
ENV GATEWAY_HOST=0.0.0.0
EXPOSE 8090

USER allglance
CMD ["node", "src/server.js"]
