# syntax=docker/dockerfile:1

# Base image pinned by digest. Dependabot proposes a new digest when the tag moves; the weekly rebuild also picks up
# Alpine security fixes through `apk upgrade` below.
ARG NODE_IMAGE=node:22-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Exactly the locked versions, production dependencies only, no install scripts.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE}

# Chromium and fonts come from Alpine's own repositories, so Alpine's security updates apply. tini is PID 1 so signals reach
# Node and stray Chromium processes are reaped.
RUN apk upgrade --no-cache \
 && apk add --no-cache chromium tini font-noto font-noto-emoji \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
# The last line removes the package managers that ship with the Node base image. The service never runs them, and their bundled
# libraries are a regular source of vulnerability reports. Dependencies are installed in the build stage above.

ENV NODE_ENV=production \
    HOME=/tmp \
    PORT=3000 \
    CHROME_BIN=/usr/bin/chromium

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib

# Runs as the unprivileged "node" user that the base image provides.
USER node
EXPOSE 3000

# Any answer below 500 means the service is up (an empty request is refused with 403, which proves the guard is running).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
