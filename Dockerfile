# ============================================================
# Personal Automation System — Multi-stage Dockerfile
# ============================================================
# Stage 1: Build (Node.js + pnpm + TypeScript)
# Stage 2: Runtime (lean image with Python for audio casting)
# ============================================================

# -- Build stage --
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy package manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY core/package.json core/
COPY apps/echo/package.json apps/echo/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code and config
COPY tsconfig.base.json ./
COPY core/ core/
COPY apps/ apps/

# Build TypeScript
RUN pnpm build

# Remove devDependencies to slim down node_modules
RUN pnpm prune --prod

# -- Runtime stage --
FROM node:22-alpine

# Install Python 3 and ffmpeg for audio casting (pychromecast + TTS)
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir pychromecast

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Copy production node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core/node_modules ./core/node_modules

# Copy compiled output
COPY --from=builder /app/core/dist ./core/dist

# Copy package manifests (needed for module resolution)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/core/package.json ./core/

# Copy echo app (and any future apps)
COPY --from=builder /app/apps ./apps

# Copy non-TS assets that tsc doesn't emit
COPY core/src/gui/views/ ./core/dist/gui/views/
COPY core/src/gui/public/ ./core/dist/gui/public/
COPY core/src/schemas/ ./core/dist/schemas/

# Copy casting script
COPY scripts/ ./scripts/

# Create data directory
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "core/dist/bootstrap.js"]
