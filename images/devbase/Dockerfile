# cogmo-devbase — base task-container image for coding-delegation.
#
# Built and published as the `devbase` target of `/docker-bake.hcl` by
# .github/workflows/publish.yml at every cogmo release. Tag tracks the
# cogmo app version, so `cogmo:1.46.0` always pairs with
# `cogmo-devbase:1.46.0`. See design/coding-delegation.md → "Base Image"
# for the full contract.
#
# Today's image ships what plan-only Claude Code flows need plus the uv
# toolchain skill-authoring tasks rely on (`uv pip compile` to produce a
# `requirements.lock` byte-identical to what `cogmo-skills` resolves at
# register time):
#   - Node 24 + pnpm + git + gh + ripgrep + fd + jq + curl
#   - @anthropic-ai/claude-code (pinned)
#   - Python 3 (from devcontainers/base) + uv (pinned to match cogmo-skills)
#   - Non-root user `vscode` (UID 1000) inherited from the devcontainers base.
#
# Codex CLI and Go/Rust toolchains are deferred to whenever real verify
# commands need them.

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# Make `RUN ... | ...` fail when any element of the pipe fails. The
# nodesource install (`curl ... | bash -`) below silently succeeds on a
# truncated curl without this.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# devcontainers/base already ships git, gh, curl, jq, ripgrep — but `fd-find`
# is missing on Ubuntu and the binary is named `fdfind` rather than `fd`.
#
# `apt-get upgrade` applies Ubuntu security updates that landed after the
# upstream rebuild — the devcontainers base image trails published USN
# advisories by days to weeks and accumulates a large CVE surface on the
# `ubuntu-24.04` tag. Hadolint's DL3005 disagrees with this on the premise
# that maintainers keep base images patched; in practice they don't, and
# this image runs inside sysbox sandboxes where every patch we can apply
# at build time tightens the userland surface.
# hadolint ignore=DL3005
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Node 24 LTS via NodeSource — required for the claude-code CLI runtime.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (bundled with Node 24). Pin matches the host repo.
RUN corepack enable \
 && corepack prepare pnpm@10.27.0 --activate

# Claude Code CLI — pinned. Version drift breaks the stream-json contract that
# src/agent/coding/claude.ts depends on. Bump deliberately in the same PR
# that bumps the parser, so the next cogmo release ships matched code +
# image at the same semver. Never `latest`.
ARG CLAUDE_CODE_VERSION=2.1.138
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version

# uv — copied from astral's distroless image, pinned to the same version
# `images/skills/Dockerfile` uses so author-side `uv pip compile` produces
# lockfiles byte-identical to what `cogmo-skills` re-resolves at register
# time. Bump both Dockerfiles together.
COPY --from=ghcr.io/astral-sh/uv:0.11.12 /uv /uvx /usr/local/bin/

# Drop privileges. Cogmo's supervisor mounts the worktree at /workspace and
# always overrides Entrypoint/Cmd at create-container time, so we leave the
# image's default entrypoint alone (devcontainers/base provides one suitable
# for `docker run` smoke tests).
USER vscode
WORKDIR /workspace
