# syntax=docker/dockerfile:1.7

# Alpine, not Debian: bookworm and trixie both carry ~20 CRITICAL/HIGH OS CVEs
# that Debian will not or cannot fix (zlib CVE-2023-45853, perl, util-linux);
# this base carries none. The production dependency tree is pure JavaScript, so
# musl costs nothing. Pinned by digest - the CI scan gate says when to bump it.
ARG NODE_IMAGE=node:24.19-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_IMAGE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The Node base image lags Alpine's package repo: every node:24.x-alpine3.24
# tag still ships openssl 3.5.7-r0 (CVE-2026-14456, HIGH) while v3.24/main has
# 3.5.8-r0. 24.19 and 24.20 share one base layer, so bumping the Node patch
# fixes nothing - upgrade the packages directly. Drop this line once the base
# image catches up and the CI scan stays green without it.
RUN apk add --no-cache --upgrade libcrypto3 libssl3

# Nothing at runtime shells out to a package manager, and npm's own bundled
# dependencies (tar, undici, brace-expansion, ip-address) are otherwise the
# only remaining source of CVEs in the image. Production modules are installed
# in the `deps` stage and copied in below.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

COPY --from=deps /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
# Read at runtime for the served server version (src/server.ts).
COPY package.json ./
COPY migrations/ ./migrations/

USER node
EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3010/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--config", "/etc/agent-memory/mcp.toml"]
