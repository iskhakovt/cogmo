# cogmo-devbase — base task-container image for coding-delegation.
#
# Built and published as the `devbase` target of `/docker-bake.hcl` by
# .github/workflows/publish.yml at every cogmo release. Tag tracks the
# cogmo app version, so `cogmo:1.46.0` always pairs with
# `cogmo-devbase:1.46.0`. See design/coding-delegation.md → "Base Image"
# for the full contract.
#
# Today's image ships what plan-only Claude Code flows need:
#   - Node 24 + pnpm + git + gh + ripgrep + fd + jq + curl
#   - @anthropic-ai/claude-code (pinned)
#   - Non-root user `vscode` (UID 1000) inherited from the devcontainers base.
#
# Codex CLI, Python 3.12 + uv, Go/Rust toolchains, and docker-outside-of-docker
# are deferred to whenever real verify commands need them.

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Make `RUN ... | ...` fail when any element of the pipe fails. The
# nodesource install (`curl ... | bash -`) below silently succeeds on a
# truncated curl without this.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# devcontainers/base already ships git, gh, curl, jq, ripgrep — but `fd-find`
# is missing on Ubuntu and the binary is named `fdfind` rather than `fd`.
RUN apt-get update \
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

# Drop privileges. Cogmo's supervisor mounts the worktree at /workspace and
# always overrides Entrypoint/Cmd at create-container time, so we leave the
# image's default entrypoint alone (devcontainers/base provides one suitable
# for `docker run` smoke tests).
USER vscode
WORKDIR /workspace
