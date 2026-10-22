# Container-native dayGLANCE MCP server.
#
# Runs the ported dayglance MCP (see server.mjs) as a small Node service so the
# AllGLANCE gateway can consume dayglance's real tool surface over the compose
# network — the thing the dayglance Docker image itself cannot do (it ships
# nginx + a static SPA, no Electron, no MCP).
#
# Build:  docker build -t allglance/dayglance-mcp ./gateway/container-mcp
# Run:    via the top-level docker-compose.yml (service: dayglance-mcp)

FROM node:20-alpine

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# The ported server + vendored model.
COPY . .

# State document lives on a mounted volume; the container writes it on writes.
ENV DAYGLANCE_STATE_FILE=/data/dayglance-state.json
ENV DAYGLANCE_MCP_PORT=7893
ENV NODE_ENV=production

EXPOSE 7893

# Simple liveness: the server answers 401 (no token) or 200 on /mcp; either
# proves the listener is up. A TCP connect check avoids needing the token.
HEALTHCHECK --interval=20s --timeout=4s --retries=5 \
  CMD node -e "const s=require('net').connect(process.env.DAYGLANCE_MCP_PORT||7893,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"

CMD ["node", "index.mjs"]
