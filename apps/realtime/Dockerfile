# GameArena realtime service.
#
# Built from the REPOSITORY ROOT, not this directory — the service depends on
# three workspace packages (@gamearena/db, /games, /shared) that live outside
# it, and npm workspaces need the root lockfile to install a reproducible tree:
#
#   docker build -f apps/realtime/Dockerfile -t gamearena-realtime .
#
# Runs the TypeScript directly through tsx rather than pre-compiling. The
# service is small, tsx starts in milliseconds, and a build step would have to
# resolve the workspace packages' own TS output — complexity that buys nothing
# for a process that is started once per deploy.

FROM node:22-slim AS base
WORKDIR /app

# openssl is required by Prisma's query engine on slim images.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# ── Dependencies ──
# Manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY apps/realtime/package.json           apps/realtime/
COPY packages/db/package.json             packages/db/
COPY packages/games/package.json          packages/games/
COPY packages/shared/package.json         packages/shared/

# The web app is not needed to run this service, but npm ci wants every
# workspace it finds in the root manifest to exist.
COPY apps/web/package.json                apps/web/

RUN npm ci --omit=dev --ignore-scripts

# ── Source ──
COPY packages/ packages/
COPY apps/realtime/ apps/realtime/

# Prisma's client is generated, not published — postinstall scripts are skipped
# above (npm 11 blocks them), so it has to be explicit.
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

# tsx is a devDependency of the realtime app and was omitted; add just it.
RUN npm install --no-save tsx@^4.19.0

ENV NODE_ENV=production
# The platform overrides this; the service reads REALTIME_PORT or falls back.
ENV REALTIME_PORT=8080
EXPOSE 8080

# Fails the container if the service stops answering, so the platform restarts
# it rather than leaving a dead process holding the port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REALTIME_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/realtime/src/index.ts"]
