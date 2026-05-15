# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim

# OS dependencies needed for the stealth Chromium binary that cloakbrowser
# downloads. Mirrors the playwright/chromium install footprint.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache the cloakbrowser Chromium binary inside the image instead of
# $HOME/.cloakbrowser so it survives container recreation without a volume.
ENV CLOAKBROWSER_CACHE_DIR=/app/.cloakbrowser
ENV CLOAKBROWSER_AUTO_UPDATE=false

# Deps first for layer caching. Includes tsx (used at runtime — we don't build).
COPY package.json package-lock.json ./
RUN npm ci

# Pre-fetch the stealth Chromium binary so first boot doesn't have to.
RUN npx cloakbrowser install

# Sources.
COPY tsconfig.json ./
COPY src ./src

# Mount point for the persistent CloakBrowser profile + state JSONs. The
# host must populate this with a bootstrapped profile before first start
# (see README "Deployment").
VOLUME /app/sessions

# Default: long-running daily agent. Override CMD to run --once / healthcheck.
CMD ["npx", "tsx", "src/agent/runner.ts"]
