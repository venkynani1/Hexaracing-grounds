# CODE REDLINE authoritative game server — a long-running process (never serverless).
# Build from the repo root:  docker build -f apps/server/Dockerfile -t code-redline-server .
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/server/package.json apps/server/
COPY tools/loadtest/package.json tools/loadtest/
COPY tools/mapbuild/package.json tools/mapbuild/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @redline/server --include-workspace-root=false
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/server apps/server
EXPOSE 2567
# Secrets come from the platform's secret store (fly secrets / Render env), never from the image.
CMD ["npx", "tsx", "apps/server/src/index.ts"]
