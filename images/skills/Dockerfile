# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
#
# cogmo-skills — base task-container image for tier-2 (sysbox) skills.
#
# Built and published as the `skills` target of `/docker-bake.hcl` by
# .github/workflows/publish.yml at every cogmo release. Tag tracks the
# cogmo app version. See `design/skills.md` → "Tier 2 — Sysbox container"
# for the contract.
#
# Two-stage build with uv: builder syncs the locked deps + builds the
# `cogmo_skills_runtime` package into a venv; runtime stage copies the
# venv AND the uv binary itself — register-time lockfile compile and
# first-invoke venv populate (see `design/skills.md` → Dependencies)
# both shell out to `uv` inside this image, so the runtime resolver
# matches the builder resolver byte-for-byte.
#
# `cogmo_skills_runtime` itself has zero third-party python deps; only
# the per-skill venvs populated by `uv pip sync --target …` against a
# manifest's `requirements.lock` introduce wheels into the runtime.

# uv toolchain as a stage — version + digest from docker-bake.hcl, shared
# with cogmo-devbase. ARG-in-FROM needs global scope.
ARG UV_VERSION
ARG UV_DIGEST
FROM ghcr.io/astral-sh/uv:${UV_VERSION}@${UV_DIGEST} AS uv

FROM mirror.gcr.io/library/python:3.15.0rc1-slim@sha256:858b8c9b2c764d1a3076e2c2ed64fb3f76ca2ec068ec81c1c059d3a5fcc1088e AS builder

COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1
ENV UV_PYTHON_DOWNLOADS=0
ENV UV_NO_EDITABLE=1

WORKDIR /app

# Lock-only sync first (without project source) — keeps the heavy deps
# layer cached when only src/ changes. README is required by hatchling
# for the package metadata even though we don't ship it.
COPY pyproject.toml uv.lock README.md /app/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project

# Now bring the package source and finalize the install.
COPY src /app/src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-editable

FROM mirror.gcr.io/library/python:3.15.0rc1-slim@sha256:858b8c9b2c764d1a3076e2c2ed64fb3f76ca2ec068ec81c1c059d3a5fcc1088e

ENV PYTHONUNBUFFERED=1

# `apt-get upgrade` applies Debian security updates that landed after
# the python:3.14-slim rebuild. Hadolint's DL3005 advises against this
# on the premise that maintainers keep base images patched; in practice
# the slim image trails Debian DSA advisories and this image runs inside
# sysbox sandboxes where every patch we can apply at build time tightens
# the userland surface. Cache cleanup keeps the runtime layer small.
# hadolint ignore=DL3005
RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

# Non-root user (UID 1000, regular-user range — matches devbase's `vscode`
# user). Sysbox already maps the in-container root to a non-root host uid
# via user namespaces; this is defense in depth.
RUN useradd -m -u 1000 -s /bin/bash cogmo

# Copy just the venv from the builder. Owns it as cogmo so the supervisor
# can write byte-cache invalidations etc. without root.
COPY --from=builder --chown=cogmo:cogmo /app/.venv /opt/cogmo-skills/.venv
ENV PATH="/opt/cogmo-skills/.venv/bin:${PATH}"
ENV VIRTUAL_ENV="/opt/cogmo-skills/.venv"

# uv in the runtime image too — the host runs `uv pip compile` at register
# and `uv venv` + `uv pip sync` at first invoke.
COPY --from=uv /uv /uvx /usr/local/bin/

# Pre-create /skill-venvs owned by `cogmo`. A fresh Docker named volume
# inherits this ownership on first mount, so the non-root supervisor
# can write into it without a CAP_CHOWN dance at runtime.
RUN mkdir -p /skill-venvs && chown cogmo:cogmo /skill-venvs

# Cogmo's host (`src/skills/worker-sysbox/worker.ts`) overrides the
# Entrypoint/Cmd at create-container time; the default below is for
# `docker run` smoke tests. WORKDIR is the user's home so any temp
# files the skill writes land somewhere writable.
USER cogmo
WORKDIR /home/cogmo
CMD ["python3", "-u", "-m", "cogmo_skills_runtime"]
