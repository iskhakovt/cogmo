FROM mirror.gcr.io/library/node:24-slim@sha256:24dc26ef1e3c3690f27ebc4136c9c186c3133b25563ae4d7f0692e4d1fe5db0e AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY migrations/ migrations/
COPY vendor/ vendor/
COPY data/ data/
# Build-time guard: the resolver's LiteLLM snapshot loader expects this
# file at the deploy root. Failing here is louder than silently falling
# back to the conservative default (128k/4k) for every model in prod.
RUN test -s data/litellm-models.json
RUN pnpm build
RUN pnpm --filter cogmo deploy --prod /deploy

FROM base
ENV NODE_ENV=production
WORKDIR /app

# git is required at runtime by `bootstrapSkillsRepo` (`git init --bare`) and
# every operation in `src/skills/git-ops.ts` (rev-parse, show, update-ref,
# merge-base). `ca-certificates` is required for `git clone` over HTTPS in
# `transport.repos.cloneAndAdd` (otherwise: "server certificate verification
# failed. CAfile: none"); `openssh-client` is required for `git@host:` SSH
# remotes in the same path. The `node` user (UID 1000) ships in `node:24-slim`;
# bind-mounted state directories from the host must be chowned 1000:1000 to match.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/cogmo/skills /var/lib/cogmo/repos /var/lib/cogmo/worktrees /var/lib/cogmo/askpass \
 && git init --bare /var/lib/cogmo/skills \
 && chown -R node:node /var/lib/cogmo

USER node
COPY --from=build --chown=node:node /deploy .

ARG VERSION=dev
ENV VERSION=$VERSION

# health endpoint
EXPOSE 9090
ENTRYPOINT ["node", "--import", "./dist/otel.js", "dist/main.js"]
CMD ["serve"]
