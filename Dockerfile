FROM mirror.gcr.io/library/node:24-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS base

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
# Avoids corepack — its LKG default seeds an older pnpm whose bundled deps trivy flags.
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.match(/^pnpm@([^+]+)/)[1]")" \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && pnpm --version
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
#
# `apt-get upgrade` applies Debian security updates that landed after the
# base-image rebuild. Hadolint's DL3005 advises against this on the
# premise that base maintainers keep up — in practice node:24-slim trails
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
