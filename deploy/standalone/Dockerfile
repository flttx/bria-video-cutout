# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production CUTOUT_DEPLOYMENT=standalone DATA_DIR=/app/data API_PORT=3001
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

# The user explicitly requests private images with embedded server credentials.
# Secret mounts keep values out of build arguments/logs; the final files ARE secret.
FROM api AS api-private
USER root
RUN --mount=type=secret,id=api_config,required=true \
    install -o node -g node -m 0400 /run/secrets/api_config /app/private.env
USER node
ENV CUTOUT_CONFIG_FILE=/app/private.env
