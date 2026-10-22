# AllGLANCE gateway image.
#
# Multi-stage: build/install deps, then run. Playwright's chromium (used by the
# lastglance + lifeglance adapters when the apps run as Docker web builds) is
# installed with system deps so the Playwright reader works out of the box.
#
# Build:  docker build -t allglance/gateway ./gateway
# Run:    via docker compose up --build (see top-level docker-compose.yml)

FROM node:22-bookworm AS deps
WORKDIR /app

# Enable pnpm via corepack (bundled with node:22).
ENV COREPACK_ENABLED=true
RUN corepack enable && corepack prepare pnpm@9 --activate

# Install dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Install the headless browser + OS deps for the Playwright fallback reader
# (lastglance/lifeglance localStorage reads in the Docker web deployment).
RUN npx playwright install --with-deps chromium

# ---- Runtime ----
FROM node:22-bookworm
ENV NODE_ENV=production
WORKDIR /app

# Non-root user.
RUN groupadd -r allglance && useradd -r -g allglance -d /app allglance

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Config + runtime data (roster cache, MCP session state) lives here.
ENV GATEWAY_HOST=0.0.0.0
EXPOSE 8090

USER allglance
CMD ["node", "src/server.js"]
