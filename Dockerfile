FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY config ./config
RUN npm run build

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS runtime
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/nlsoarez/bioecos-whatsapp" \
      org.opencontainers.image.revision="${BUILD_REVISION}"
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/config ./config
COPY --chown=node:node src/db/migrations ./dist/src/db/migrations
USER node
EXPOSE 3000
CMD ["npm", "run", "start:docker"]
