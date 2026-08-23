# Dependencies are installed rather than bundled — the Wormhole SDK's Cosmos/Injective packages do
# not survive esbuild's CJS flattening. See esbuild.dist.mjs.
FROM --platform=$BUILDPLATFORM node:25-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

FROM node:25-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY dist/index.js ./index.js

CMD ["node", "index.js"]
