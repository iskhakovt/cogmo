# syntax=docker/dockerfile:1
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

FROM mirror.gcr.io/library/python:3.14.5-slim@sha256:c845af9399020c7e562969a13689e929074a10fd057acd1b1fad06a2fb068e97 AS builder

# uv binary copied from astral's distroless image — no apt install,
# pinned to a specific astral release tag + digest so a `uv sync` is
# deterministic across rebuilds. Bump in lockstep with `images/devbase/Dockerfile`.
COPY --from=ghcr.io/astral-sh/uv:0.11.12@sha256:3a59a3cdd5f7c217faa36e32dbc7fddbb0412889c2a0a5229f6d790e5a019dd7 /uv /uvx /bin/

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

FROM mirror.gcr.io/library/python:3.14.5-slim@sha256:c845af9399020c7e562969a13689e929074a10fd057acd1b1fad06a2fb068e97

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

# uv binary lives in the runtime image too — the host runs
# `uv pip compile` here at register (to verify the committed
# requirements.lock is current) and `uv venv` + `uv pip sync` at first
# invocation (to populate the per-skill venv at /skill-venvs/<hash>/).
# Pinned to the same astral release tag as the builder stage so the
# resolver behaviour is identical end-to-end.
COPY --from=ghcr.io/astral-sh/uv:0.11.12 /uv /uvx /usr/local/bin/

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
