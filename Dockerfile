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
# Testnet by default, stated explicitly rather than relied on: with no signer
# set the server comes up read-only, which is what automated introspection
# (tools/list) needs, and every network's contract addresses ship inside the
# SDK, so nothing else has to be baked in here.
ENV ARC_NETWORK=arc-testnet
#
# To serve BaseBounty on Base mainnet instead, that one variable is the whole
# change - no addresses, no RPC:
#   -e ARC_NETWORK=base-mainnet
# (also base-sepolia for its staging deployment).
#
# To target Arc Mainnet, override at `docker run` time:
#   -e ARC_NETWORK=arc-mainnet \
#   -e ARC_MAINNET_CHAIN_ID=... -e ARC_MAINNET_RPC_URL=... \
#   -e ARC_MAINNET_EXPLORER_URL=... -e ARC_MAINNET_EXPLORER_API_URL=... \
#   -e ARC_MAINNET_AGENTIC_COMMERCE=... -e ARC_MAINNET_IDENTITY_REGISTRY=... \
#   -e ARC_MAINNET_REPUTATION_REGISTRY=... -e ARC_MAINNET_USDC=...
# Circle has not published these values yet (see agent-sdk/.env.example) -
# the server fails fast with a clear error if ARC_NETWORK=arc-mainnet is set
# without them.
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY mcp-server/README.md mcp-server/.env.example ./
USER node
# CMD rather than ENTRYPOINT: hosts that wrap the server in their own stdio
# proxy replace the command instead of appending arguments to it.
CMD ["node", "dist/index.js"]
