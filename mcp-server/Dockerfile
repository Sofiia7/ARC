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
# Canonical Arc Testnet deployment (contracts/DEPLOYMENTS.md) — lets the
# container start read-only out of the box (no signer configured) for
# automated introspection checks. Override with -e for a different network.
ENV BOUNTY_ADAPTER_ADDRESS=0x538CD48789667168bfb36f838Af8476237F9409F
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md .env.example ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
