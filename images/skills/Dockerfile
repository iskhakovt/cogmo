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
# `cogmo_skills_runtime` package into a venv; runtime stage copies just
# the venv. No build deps in the final image, no uv binary either —
# the runtime only needs `python3` + the venv at /opt/cogmo-skills/.venv.
#
# Production has zero runtime python deps today (stdlib only). The uv
# pipeline is wired so that adding a dep is `uv add` + `uv lock` + the
# image picks it up — no Dockerfile changes per dep.

FROM mirror.gcr.io/library/python:3.14-slim@sha256:a7185a8e40af01bf891414a4df16ef10fc6000cee460a404a13da9029fe41604 AS builder

# uv binary copied from astral's distroless image — no apt install,
# pinned to a specific astral release tag so a `uv sync` is deterministic.
COPY --from=ghcr.io/astral-sh/uv:0.11.12 /uv /uvx /bin/

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

FROM mirror.gcr.io/library/python:3.14-slim@sha256:a7185a8e40af01bf891414a4df16ef10fc6000cee460a404a13da9029fe41604

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

# Cogmo's host (`src/skills/worker-sysbox/worker.ts`) overrides the
# Entrypoint/Cmd at create-container time; the default below is for
# `docker run` smoke tests. WORKDIR is the user's home so any temp
# files the skill writes land somewhere writable.
USER cogmo
WORKDIR /home/cogmo
CMD ["python3", "-u", "-m", "cogmo_skills_runtime"]
