# syntax=docker/dockerfile:1

# Build from the lockfile, then copy only production dependencies and compiled
# output into the runtime image. This keeps source, tests and npm tooling out
# of the image that receives NetBox credentials.
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="netbox-mcp" \
      org.opencontainers.image.description="Model Context Protocol server for the NetBox REST API" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/ZenixSolutions/netbox-mcp-server"

ENV NODE_ENV=production \
    XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The official Node image supplies this unprivileged account. Keep it as the
# image default; Compose reinforces it and also makes the root filesystem read-only.
USER node

ENTRYPOINT ["node", "dist/index.js"]
