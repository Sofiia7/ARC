# Repo-root Dockerfile.
#
# The MCP server lives in mcp-server/, but registries that build the project
# automatically (Glama and friends) look for a Dockerfile at the repository
# root and otherwise fall back to guessing the build steps for the whole
# monorepo. Keeping a root-level Dockerfile makes that build deterministic.
#
#   docker build -t arcbounty-mcp .
#   docker run --rm -i arcbounty-mcp

FROM node:24-alpine AS build
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci
COPY mcp-server/tsconfig.json ./
COPY mcp-server/src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Canonical Arc Testnet deployment (contracts/DEPLOYMENTS.md). Baked in so the
# container starts with no configuration at all: with no signer set the server
# comes up read-only, which is what automated introspection (tools/list) needs.
# Override with -e BOUNTY_ADAPTER_ADDRESS=... for a different network.
ENV BOUNTY_ADAPTER_ADDRESS=0x538CD48789667168bfb36f838Af8476237F9409F
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY mcp-server/README.md mcp-server/.env.example ./
USER node
# CMD rather than ENTRYPOINT: hosts that wrap the server in their own stdio
# proxy replace the command instead of appending arguments to it.
CMD ["node", "dist/index.js"]
