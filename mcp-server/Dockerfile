FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Testnet-by-default so the container starts read-only out of the box (no
# signer configured) for automated introspection checks — canonical
# deployment per contracts/DEPLOYMENTS.md.
ENV ARC_NETWORK=arc-testnet
ENV BOUNTY_ADAPTER_ADDRESS=0x538CD48789667168bfb36f838Af8476237F9409F
#
# To target Arc Mainnet instead, override at `docker run` time:
#   -e ARC_NETWORK=arc-mainnet \
#   -e BOUNTY_ADAPTER_ADDRESS=<mainnet adapter address> \
#   -e ARC_MAINNET_CHAIN_ID=... -e ARC_MAINNET_RPC_URL=... \
#   -e ARC_MAINNET_EXPLORER_URL=... -e ARC_MAINNET_EXPLORER_API_URL=... \
#   -e ARC_MAINNET_AGENTIC_COMMERCE=... -e ARC_MAINNET_IDENTITY_REGISTRY=... \
#   -e ARC_MAINNET_REPUTATION_REGISTRY=... -e ARC_MAINNET_USDC=...
# Circle has not published these values yet (see agent-sdk/.env.example) —
# the server fails fast with a clear error if ARC_NETWORK=arc-mainnet is set
# without them.
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md .env.example ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
