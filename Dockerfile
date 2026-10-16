# syntax=docker/dockerfile:1.7
# One image recipe for every service:
#   docker build --build-arg APP=order -t shopflow/order:dev .
# Run:      node dist/main.js            (the service)
# Migrate:  node dist/main.js migrate    (user, order, inventory, payment)

# glibc, not alpine: bcrypt (user service) is a native module.
ARG NODE_IMAGE=node:22.19.0-bookworm-slim

# ---------- 1. all deps (cached until package-lock changes) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ---------- 2. build one app ----------
# libs/proto/src/generated is committed, so no protoc step here.
FROM deps AS build
ARG APP
RUN test -n "${APP}" || (echo "Pass --build-arg APP=<service>" >&2; exit 1)
COPY . .
RUN npx nest build ${APP}

# ---------- 3. production deps only ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---------- 4. runtime: small, non-root ----------
FROM ${NODE_IMAGE} AS runtime
ARG APP
ENV NODE_ENV=production \
    PROTO_DIR=/app/proto \
    PORT=3000
# tini as PID 1: forwards SIGTERM to Node (graceful shutdown) and reaps zombies.
# apt-get upgrade: pull Debian security fixes newer than the base image (Trivy gate).
# Remove npm/npx/corepack: the runtime never installs packages, and npm's bundled
# deps (tar, glob, minimatch, sigstore...) were most of our HIGH/CRITICAL findings.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist/apps/${APP} ./dist
COPY --from=build     --chown=node:node /app/libs/proto/src/*.proto ./proto/
USER node
EXPOSE 3000
# Liveness only (readiness checks dependencies). No curl in slim: use Node.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
