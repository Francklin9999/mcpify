FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY services/generator ./services/generator

RUN npm ci
RUN npm run build --workspace=@mcp/web
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

COPY --from=build /app /app

EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=@mcp/web", "--", "-p", "3001", "-H", "0.0.0.0"]
