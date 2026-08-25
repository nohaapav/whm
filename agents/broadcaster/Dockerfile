FROM node:23-slim

WORKDIR /app

COPY dist/ ./

# One image, one entry point per app. The service picks it:
#   command: [node, oracle-ethereum/app.js]
CMD ["node", "oracle-solana/app.js"]
