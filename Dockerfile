# syntax=docker/dockerfile:1
#
# One image per server. Build any of the ten with:
#   docker build --build-arg SERVER=jwt-tools -t mcp-jwt-tools .
# and run it on stdio (no port is opened):
#   docker run --rm -i mcp-jwt-tools
#
# The base image is pinned by digest (node:22-alpine, multi-arch index).
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# Build on the runner's own platform: the output is plain JavaScript and the dependencies have no native code.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG SERVER
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/
RUN if [ -z "${SERVER}" ] || [ ! -f "packages/${SERVER}/package.json" ]; then \
      echo "Set --build-arg SERVER to one of: $(ls packages | tr '\n' ' ')" >&2; exit 1; \
    fi
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build --workspace "packages/${SERVER}"
# Production tree for this one server: runtime dependencies from the committed lockfile, plus its dist/.
WORKDIR /out
RUN cp /src/package.json /src/package-lock.json ./ \
 && for p in /src/packages/*/; do mkdir -p "packages/$(basename "$p")" && cp "$p/package.json" "packages/$(basename "$p")/"; done \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace "packages/${SERVER}" \
 && cp -R "/src/packages/${SERVER}/dist" "/src/packages/${SERVER}/README.md" "packages/${SERVER}/" \
 && find packages -mindepth 1 -maxdepth 1 -type d ! -name "${SERVER}" -exec rm -rf {} + \
 && rm -rf /root/.npm

FROM ${NODE_IMAGE}
ARG SERVER
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="mcp-${SERVER}" \
      org.opencontainers.image.description="MCP server ${SERVER} from dev-mcp-servers, stdio transport" \
      org.opencontainers.image.source="https://github.com/basitalisandhu/dev-mcp-servers" \
      org.opencontainers.image.url="https://github.com/basitalisandhu/dev-mcp-servers/tree/main/packages/${SERVER}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      io.modelcontextprotocol.server.name="io.github.basitalisandhu/mcp-${SERVER}"
# git-insights shells out to git. Mount the repository at /repo; only that tree is marked safe for the
# container's non-root user, whose uid usually differs from the owner of the mounted files.
RUN if [ "${SERVER}" = "git-insights" ]; then \
      apk add --no-cache git \
      && git config --system --add safe.directory /repo \
      && git config --system --add safe.directory '/repo/*'; \
    fi
ENV NODE_ENV=production
COPY --from=build /out/ /app/
WORKDIR /app/packages/${SERVER}
USER node
ENTRYPOINT ["node", "dist/index.js"]
