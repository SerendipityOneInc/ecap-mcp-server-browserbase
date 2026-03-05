FROM node:22-alpine AS builder

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm run build && \
    pnpm prune --prod --ignore-scripts

FROM node:22-bookworm-slim

LABEL io.modelcontextprotocol.server.name="one.srp/mcp-server-browserbase"

WORKDIR /app

ENV BROWSERBASE_API_KEY=""
ENV BROWSERBASE_PROJECT_ID=""
ENV MODEL_API_KEY=""

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/cli.js ./cli.js
COPY --from=builder /app/index.js ./index.js

CMD node dist/program.js --modelApiKey "$MODEL_API_KEY" --modelName google/gemini-3-flash-preview
