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
# signer configured) for automated introspection checks - canonical
# deployment per contracts/DEPLOYMENTS.md.
ENV ARC_NETWORK=arc-testnet
#
# Every network's addresses ship inside the SDK, so choosing another chain is
# one variable at `docker run` time:
#   -e ARC_NETWORK=arc-mainnet     (or base-mainnet, base-sepolia)
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md .env.example ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
