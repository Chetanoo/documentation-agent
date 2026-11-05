# ---- Build the web app ----
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- API server, which also serves the built web app ----
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Full install: the server runs TypeScript directly with tsx.
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
# Fails the build on type errors or bad imports (e.g. a path that only exists on one machine).
RUN node_modules/.bin/tsc -p tsconfig.json
COPY --from=web /app/web/dist ./web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIST=web/dist \
    TRUST_PROXY=true
EXPOSE 8080
USER node
CMD ["node_modules/.bin/tsx", "src/api/server.ts"]
