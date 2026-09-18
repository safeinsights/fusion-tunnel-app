# Debian slim rather than the siblings' Alpine: the tunnel's Noise implementation rides the
# sodium-native addon, whose Linux prebuilds link against glibc (>= 2.33). The runtime image
# runs with a read-only root filesystem and no writable mounts — the tunnel writes nothing to disk.
FROM node:22-bookworm-slim AS base

ARG USER=node
ENV HOME=/home/$USER

# curl is used by the healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (runs as root before USER switch)
RUN corepack enable

USER $USER
WORKDIR $HOME/app

# --- build stage: install deps + bundle ---
FROM base AS build
COPY --chown=$USER:$USER package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=$USER:$USER . .
RUN pnpm run build

# --- dev (used by docker-compose for local hot-reload via tsx watch) ---
FROM build AS dev
CMD ["pnpm", "run", "dev"]

# --- prod-deps: the bundle inlines everything except the native addon it cannot ---
FROM build AS prod-deps
RUN pnpm prune --prod

# --- runtime (default target for production image builds) ---
FROM base AS runtime
COPY --chown=$USER:$USER --from=build $HOME/app/dist ./dist
COPY --chown=$USER:$USER --from=prod-deps $HOME/app/node_modules ./node_modules

ENV PORT=3003
HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD curl -f http://localhost:${PORT}/health || exit 1

EXPOSE 3003

CMD ["node", "dist/server.js"]
