FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Pre-install package managers + esbuild
RUN npm install -g pnpm@9 esbuild && corepack enable

WORKDIR /app
COPY dist/server.mjs /app/server.mjs

EXPOSE 8080
CMD ["node", "server.mjs"]
