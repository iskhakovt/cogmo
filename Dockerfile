FROM mirror.gcr.io/library/node:24-trixie-slim@sha256:05c08ce4291e9a58f59456a7985176defb12cdd42271f35ff81a3e167ea61d4c AS base

FROM base AS build
WORKDIR /app
# Root workspace manifest + every member package.json must be present before
# the frozen install so pnpm can resolve the workspace lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY patches/ patches/
# Corepack runs only in this stage; `prepare --activate` verifies the +sha512 hash from packageManager.
RUN corepack enable \
 && corepack prepare --activate "$(node -p "require('./package.json').packageManager")"
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY apps/server/tsconfig.json apps/server/tsup.config.ts apps/server/
COPY apps/server/src/ apps/server/src/
COPY apps/server/migrations/ apps/server/migrations/
COPY apps/server/vendor/ apps/server/vendor/
COPY apps/server/data/ apps/server/data/
# Types-only package the backend re-imports; tsc needs its source present.
COPY packages/contracts/ packages/contracts/
# Build-time guard: the resolver's LiteLLM snapshot loader expects this
# file at the deploy root. Failing here is louder than silently falling
# back to the conservative default (128k/4k) for every model in prod.
RUN test -s apps/server/data/litellm-models.json
# Build only the backend package explicitly — don't depend on the root
# `build` proxy script, so the image build can't break if that script later
# fans out to workspace members (e.g. apps/web) whose source isn't COPYed here.
RUN pnpm --filter cogmo build
RUN pnpm --filter cogmo deploy --prod /deploy

# Build the SPA last. Docker invalidates layers forward, so this keeps an
# SPA-source edit from busting the expensive server build above. A server-source
# edit does re-run this Vite build (~200ms) — the cheap side to leave exposed.
# `pnpm deploy` bundles only the cogmo package, so the dist is COPYed into the
# runtime stage separately below; it lands at /app/apps/web/dist (WEB_STATIC_ROOT).
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json apps/web/
COPY apps/web/src/ apps/web/src/
RUN pnpm --filter web build

FROM base
ENV NODE_ENV=production
WORKDIR /app

# git is required at runtime by `bootstrapSkillsRepo` (`git init --bare`) and
# every operation in `src/skills/git-ops.ts` (rev-parse, show, update-ref,
# merge-base). `ca-certificates` is required for `git clone` over HTTPS in
# `transport.repos.cloneAndAdd` (otherwise: "server certificate verification
# failed. CAfile: none"); `openssh-client` is required for `git@host:` SSH
# remotes in the same path. The `node` user (UID 1000) ships in `node:24-trixie-slim`;
# bind-mounted state directories from the host must be chowned 1000:1000 to match.
#
# `apt-get upgrade` applies Debian security updates that landed after the
# base-image rebuild. Hadolint's DL3005 advises against this on the
# premise that base maintainers keep up — in practice node:24-trixie-slim trails
# Debian security advisories by days to weeks, and the resulting CVE gap
# in our published image is real. See trivy scan output on prior builds.
# hadolint ignore=DL3005
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
 && rm -rf /var/lib/apt/lists/* \
           /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /opt/yarn-v* \
 && mkdir -p /var/lib/cogmo/skills /var/lib/cogmo/repos /var/lib/cogmo/worktrees /var/lib/cogmo/askpass /var/lib/cogmo/sockets \
 && git init --bare /var/lib/cogmo/skills \
 && chown -R node:node /var/lib/cogmo

USER node
COPY --from=build --chown=node:node /deploy .
# The Vite SPA sirv serves from WEB_STATIC_ROOT (default ./apps/web/dist, relative
# to this WORKDIR). `pnpm deploy` doesn't carry it, so copy the build output here.
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

ARG VERSION=dev
ENV VERSION=$VERSION

# web UI + health endpoint
EXPOSE 9090
ENTRYPOINT ["node", "--import", "./dist/otel.js", "dist/main.js"]
CMD ["serve"]
