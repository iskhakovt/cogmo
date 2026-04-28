FROM node:24-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY migrations/ migrations/
RUN pnpm build
RUN pnpm --filter cogmo deploy --prod /deploy

# Pre-create the persistent state directories with `nonroot` (UID 65532)
# ownership. Distroless has no shell, so we cannot mkdir at runtime —
# every directory the runtime writes to must exist with the right
# ownership when the image is built.
#
# Mounting an external volume over `/var/lib/cogmo` overrides these,
# in which case the operator is responsible for chown'ing the volume
# to UID 65532. See DEPLOYMENT.md for the volume guidance.
FROM base AS skeleton
# `node:24-slim` doesn't ship git either; install it to pre-init the bare
# skills repo (distroless has no shell or git, so bootstrap can't `git init
# --bare` at runtime).
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p \
      /skel/var/lib/cogmo/skills \
      /skel/var/lib/cogmo/repos \
      /skel/var/lib/cogmo/worktrees \
      /skel/var/lib/cogmo/askpass \
 && git init --bare /skel/var/lib/cogmo/skills \
 && chown -R 65532:65532 /skel/var/lib/cogmo

FROM gcr.io/distroless/nodejs24-debian13
ARG VERSION=dev
ENV NODE_ENV=production
ENV VERSION=$VERSION
WORKDIR /app
USER nonroot
COPY --from=build /deploy .
COPY --from=skeleton /skel/var/lib/cogmo /var/lib/cogmo
# health endpoint
EXPOSE 9090
ENTRYPOINT ["/nodejs/bin/node", "--import", "./dist/otel.js", "dist/main.js"]
CMD ["serve"]
