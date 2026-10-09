FROM node:24.3.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY config.yaml schema.graphql tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run codegen && npm run typecheck && npm test
RUN chown -R node:node /app
ENV TUI_OFF=true NODE_OPTIONS=--max-old-space-size=640
USER node
CMD ["npx", "--no-install", "envio", "start"]
