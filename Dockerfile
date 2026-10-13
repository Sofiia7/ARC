# Repo-root Dockerfile.
#
# The MCP servers live in mcp-server/, but registries that build the project
# automatically (Glama and friends) look for a Dockerfile at the repository
# root and otherwise fall back to guessing the build steps for the whole
# monorepo. Keeping a root-level Dockerfile makes that build deterministic.
#
# The container runs the NadBounty server (Monad mainnet, read-only without a
# key). Arc and Base are served by the same build through the other entry
# point, see the notes next to CMD.
#
#   docker build -t nadbounty-mcp .
#   docker run --rm -i nadbounty-mcp

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
# NadBounty on Monad mainnet is the default of this entry point, so nothing
# network specific has to be set: with no signer the server comes up read-only
# (13 tools), which is what automated introspection (tools/list) needs, and
# the contract addresses ship inside the SDK. The version is reported at
# initialize and matches the published nadbounty-mcp package.
ENV NAD_MCP_VERSION=0.2.0
#
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY mcp-server/README.md mcp-server/.env.example ./
USER node
# CMD rather than ENTRYPOINT: hosts that wrap the server in their own stdio
# proxy replace the command instead of appending arguments to it.
#
# To serve BaseBounty or ArcBounty instead, run the other entry point with one
# variable and no addresses or RPC:
#   docker run --rm -i -e ARC_NETWORK=base-mainnet nadbounty-mcp node dist/index.js
#   (also arc-mainnet, arc-testnet and base-sepolia)
CMD ["node", "dist/nad-cli.js"]
