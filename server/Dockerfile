# ============================================================
# server/Dockerfile — arm64 image for the gamut multiplayer server.
#
# CRITICAL — BUILD CONTEXT IS THE REPO ROOT, NOT server/.
#   The server reuses the shared pure engine at the REPO ROOT (engine.js);
#   server/rooms.js and server/session.js both do require('../engine.js').
#   So the image must place engine.js ONE LEVEL ABOVE the server files:
#       /app/engine.js
#       /app/server/index.js  (etc.)  → require('../engine.js') → /app/engine.js
#   A Dockerfile can't COPY paths outside its context, so the context must be
#   the repo root and this file referenced with -f:
#       docker build -f server/Dockerfile -t gamut-server .
#   The CI workflow sets `context: .` + `file: server/Dockerfile` to match.
#
# Target: linux/arm64 (Raspberry Pi 4B). Built under QEMU in GitHub Actions;
# see .github/workflows/server.yml. Follows the Part-D container hygiene in
# GAME-SERVER-PLATFORM.md: pinned base, production deps only, USER node,
# HEALTHCHECK on /health.
# ============================================================

# ---- Stage 1: install production dependencies ----------------------------
# Isolated so build tooling / npm cache never reach the runtime image.
FROM node:20-alpine AS deps
WORKDIR /app/server

# `package*.json` always matches package.json, and package-lock.json WHEN it
# exists. There is no committed lockfile yet, so the RUN below falls back to
# `npm install`; commit a lockfile (see note) to get reproducible `npm ci`.
COPY server/package*.json ./

# SECURITY NOTE: `npm ci` / `npm install` executes dependency lifecycle
# scripts at build time (supply-chain surface). `ws` is the only runtime dep
# and is pure-JS (its native accelerators are OPTIONAL and skipped on alpine,
# so no python/gcc/build-base is needed). Keep `ws` pinned >= 8.17.1 (Part D).
#   - lockfile present  → `npm ci --omit=dev`   (reproducible, preferred)
#   - lockfile absent   → `npm install --omit=dev` (works today; not pinned)
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ---- Stage 2: runtime -----------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production

# Stamped into GET /health so a deployment is verifiable (Phase F: confirm the
# Pi actually pulled the new image). CI passes the commit SHA; default "dev"
# for local builds. index.js reads process.env.APP_VERSION.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

WORKDIR /app

# engine.js sits one level ABOVE the server files (see header).
COPY engine.js ./engine.js
# Server source (index.js / rooms.js / session.js / package.json). A stray
# local node_modules, if any, is excluded by .dockerignore.
COPY server/ ./server/
# Clean production node_modules from the deps stage.
COPY --from=deps /app/server/node_modules ./server/node_modules

# Drop root — the process only reads its own files and holds sockets in RAM;
# it never writes to disk, so root-owned read-only files are fine for `node`.
USER node

EXPOSE 9000

# Liveness: hit the same /health the browser boot-probe uses. Uses node itself
# (already present) rather than adding curl/wget; PORT honoured if overridden.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||9000;require('http').get('http://127.0.0.1:'+p+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# require('../engine.js') resolves relative to the requiring file (/app/server),
# so CWD /app + `node server/index.js` reaches /app/engine.js correctly.
CMD ["node", "server/index.js"]
