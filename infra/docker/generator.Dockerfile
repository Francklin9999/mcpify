FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services/generator ./services/generator

RUN npm ci
RUN npm run build --workspace=@mcp/types \
  && npm run build --workspace=@mcp/db \
  && npm run build --workspace=@mcp/generator
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV ENQUEUE_PORT=8081

COPY --from=build /app /app

EXPOSE 8081
CMD ["npm", "run", "worker", "--workspace=@mcp/generator"]
