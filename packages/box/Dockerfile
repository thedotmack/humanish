# Humanish box image.
#
# Base: neko's chromium image (provides neko + Xorg + Chromium + WebRTC).
# We layer Node 20 on top and add our action runner.
#
# Build context MUST be the repo root so we can COPY the action runner
# subtree from `packages/box/action-runner`. The repo's package.json
# scripts handle this:
#   pnpm install
#   pnpm --filter @humanish/action-runner build  # produces dist/
#   pnpm box:build                               # docker build -f packages/box/Dockerfile .

FROM ghcr.io/m1k1o/neko/chromium:latest

# Node 20 via NodeSource (matches the action runner's tsconfig target).
# `ca-certificates` and `curl` are usually present in the neko image but
# we install defensively.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/action-runner

# Install production deps using the action runner's own package.json.
# The runner has zero workspace dependencies (everything it uses is a
# normal npm package: fastify, playwright, zod, ulid). We deliberately
# do NOT copy the monorepo pnpm-lock.yaml — we let npm resolve fresh from
# the action runner's manifest so the image is self-contained and the
# pnpm symlink farm never enters the container.
COPY packages/box/action-runner/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Pre-built JS (we build on the host via `pnpm --filter @humanish/action-runner build`
# before `docker build`). The TypeScript sources are never copied — only dist.
COPY packages/box/action-runner/dist ./dist

# Drop the action runner into neko's supervisord include directory so it
# starts alongside Xorg, openbox, neko, and chromium under the upstream
# image's supervisord. We deliberately do NOT override ENTRYPOINT — the
# base image already does the right thing (supervisord with full
# desktop/audio/webrtc plumbing), and a hand-rolled entrypoint.sh was
# bypassing Xorg init causing neko to panic on startup.
COPY packages/box/action-runner.conf /etc/neko/supervisord/action-runner.conf

COPY packages/box/neko.yaml /etc/neko.yaml

# 7654: action runner (public TLS on fly.toml, BOX_SHARED_SECRET-gated).
# 8080: neko WebRTC + HTTP (public via fly.toml).
EXPOSE 7654 8080
