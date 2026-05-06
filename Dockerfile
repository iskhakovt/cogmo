FROM mirror.gcr.io/library/node:24-slim AS base
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

FROM base
ARG VERSION=dev
ENV NODE_ENV=production
ENV VERSION=$VERSION
WORKDIR /app

# git is required at runtime by `bootstrapSkillsRepo` (`git init --bare`) and
# every operation in `src/skills/git-ops.ts` (rev-parse, show, update-ref,
# merge-base). The `node` user (UID 1000) ships in `node:24-slim`; bind-mounted
# state directories from the host must be chowned 1000:1000 to match.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/cogmo/skills /var/lib/cogmo/repos /var/lib/cogmo/worktrees /var/lib/cogmo/askpass \
 && git init --bare /var/lib/cogmo/skills \
 && chown -R node:node /var/lib/cogmo

USER node
COPY --from=build --chown=node:node /deploy .

# health endpoint
EXPOSE 9090
ENTRYPOINT ["node", "--import", "./dist/otel.js", "dist/main.js"]
CMD ["serve"]
