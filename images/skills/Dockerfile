# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
#
# cogmo-skills — base task-container image for container-tier (sysbox) skills.
#
# Built and published as the `skills` target of `/docker-bake.hcl` by
# .github/workflows/publish.yml at every cogmo release. Tag tracks the
# cogmo app version. See `design/skills.md` → "Container tier — sysbox"
# for the contract.
#
# Built with uv: builder syncs the locked deps + builds the
# `cogmo_skills_runtime` package into a venv; runtime stage copies the
# venv AND the uv binary itself — register-time lockfile compile and
# first-invoke venv populate (see `design/skills.md` → Dependencies)
# both shell out to `uv` inside this image, so the runtime resolver
# matches the builder resolver byte-for-byte. The `tools` and `toolchain`
# stages build what register's CPython checks run: the skills repo
# toolchain's tools venv and its configuration.
#
# `cogmo_skills_runtime` itself has zero third-party python deps; only
# the per-skill venvs populated by `uv venv` + `uv pip sync` against a
# manifest's `requirements.lock` introduce wheels into the runtime.
#
# The `mutation` stage is a local test image for
# `pnpm test:mutation:skills`; the release build never reaches it.

# uv toolchain as a stage — version + digest from docker-bake.hcl, shared
# with cogmo-devbase. ARG-in-FROM needs global scope.
ARG UV_VERSION
ARG UV_DIGEST
FROM ghcr.io/astral-sh/uv:${UV_VERSION}@${UV_DIGEST} AS uv

FROM mirror.gcr.io/library/python:3.14.10-slim@sha256:af8a5aa14780025dbfbcfbc81bd8a91ebd87711dd5b0f48ed71090949dd7cb1d AS builder

COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV UV_NO_DEV=1
ENV UV_PYTHON_DOWNLOADS=0
ENV UV_NO_EDITABLE=1

WORKDIR /app

# Lock-only sync first (without project source) — keeps the heavy deps
# layer cached when only src/ changes. README is required by hatchling
# for the package metadata even though we don't ship it. `.python-version`
# is the Python minor CI tests against; with downloads off, a FROM on any
# other minor fails this sync instead of shipping an untested runtime.
COPY pyproject.toml uv.lock README.md .python-version /app/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project

# Now bring the package source and finalize the install.
COPY src /app/src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-editable

# design/testing.md → Mutation Testing. The packages resolve to `/app/src`,
# which scripts/mutation.sh overlays with mutmut's mutated copy to re-run a
# mutant, so the `python -I` subprocesses the suite starts run it too.
FROM builder AS mutation
ENV UV_NO_DEV=0
RUN --mount=type=cache,target=/root/.cache/uv \
    rm -rf .venv \
 && uv sync --locked --group mutation --no-install-project \
 && echo /app/src > "$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')/cogmo_skills_mutants.pth" \
 && install -d -o 1000 -g 1000 /app/mutants
COPY tests /app/tests/
COPY contract /app/contract/
ENV PATH="/app/.venv/bin:${PATH}" HOME=/tmp PYTHONDONTWRITEBYTECODE=1
USER 1000:1000

# The tools register's CPython checks run (design/skills.md → Register-time
# CPython checks): the skills repo toolchain's whole dev group, from the lock
# the repo commits, so it cannot drift from what `.cogmo/verify` runs. The
# builder's UV_NO_DEV=1 would drop the group; `--locked` fails a stale lock.
FROM builder AS tools
ENV UV_NO_DEV=0 UV_PROJECT_ENVIRONMENT=/opt/cogmo-skills/tools
WORKDIR /toolchain
COPY toolchain/pyproject.toml toolchain/uv.lock /toolchain/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --only-group dev --no-install-project

# The toolchain's entries as the boot commits them to the skills repo: those
# `.cogmo/paths` lists, with `cogmo_ctx` joined into `.cogmo/`. The checks
# read their configuration here, the files the author's `.cogmo/verify` reads.
FROM builder AS toolchain
COPY toolchain /src/toolchain/
COPY src/cogmo_ctx /src/cogmo_ctx/
RUN install -d /opt/cogmo-skills/toolchain \
 && while read -r entry; do \
      [ -z "${entry}" ] || cp -a "/src/toolchain/${entry}" /opt/cogmo-skills/toolchain/; \
    done < /src/toolchain/.cogmo/paths \
 && cp -a /src/cogmo_ctx /opt/cogmo-skills/toolchain/.cogmo/cogmo_ctx \
 && find /opt/cogmo-skills/toolchain \( -name __pycache__ -o -name '*.py[co]' \) -prune -exec rm -rf {} +

FROM mirror.gcr.io/library/python:3.14.10-slim@sha256:af8a5aa14780025dbfbcfbc81bd8a91ebd87711dd5b0f48ed71090949dd7cb1d

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

# Nothing here uses the base image's pip: the supervisor and every skill run
# in venvs without system site-packages, and uv does all resolves and
# installs. Left installed, the copies it vendors (certifi, urllib3, msgpack,
# setuptools) would show in every scan, fixable only by a pip release.
RUN python3 -m pip uninstall --yes --root-user-action=ignore pip

# Non-root user (UID 1000, regular-user range — matches devbase's `vscode`
# user). Sysbox already maps the in-container root to a non-root host uid
# via user namespaces; this is defense in depth.
RUN useradd -m -u 1000 -s /bin/bash cogmo

# Copy just the venv from the builder, root-owned so `cogmo` can only read it.
# A task runs as `cogmo`, and the venv's `bin/` is first on PATH for the
# populate and reap scripts the host runs on a warm worker: a task able to
# write it could swap `python3` for code the next script runs. Nothing writes
# here at runtime; UV_COMPILE_BYTECODE precompiled the bytecode, and skill
# venvs live on /skill-venvs.
COPY --from=builder /app/.venv /opt/cogmo-skills/.venv
ENV PATH="/opt/cogmo-skills/.venv/bin:${PATH}"
ENV VIRTUAL_ENV="/opt/cogmo-skills/.venv"
# The venv links to the builder's interpreter, so a runtime FROM on another
# minor fails here rather than at the first task.
RUN "${VIRTUAL_ENV}/bin/python" --version

# uv in the runtime image too — the host runs `uv pip compile` at register
# and `uv venv` + `uv pip sync` at first invoke. Downloads stay off so they
# resolve on this image's Python instead of fetching another.
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=0

# Pre-create /skill-venvs owned by `cogmo`. A fresh Docker named volume
# inherits this ownership on first mount, so the non-root supervisor
# can write into it without a CAP_CHOWN dance at runtime.
RUN mkdir -p /skill-venvs && chown cogmo:cogmo /skill-venvs

# The tools venv and the toolchain register's CPython checks read, root-owned
# like the runtime venv, with the bytecode UV_COMPILE_BYTECODE compiled. No
# PATH or sys.path names the tools venv: `cogmo_skills_runtime.check` runs
# each tool by its absolute path, and no task sees them.
COPY --from=tools /opt/cogmo-skills/tools /opt/cogmo-skills/tools
COPY --from=toolchain /opt/cogmo-skills/toolchain /opt/cogmo-skills/toolchain

# The release this toolchain belongs to, which a check reply carries. Last, so
# a version bump rebuilds this layer alone.
ARG VERSION
RUN printf '%s\n' "${VERSION}" > /opt/cogmo-skills/VERSION

# Cogmo's host (`src/skills/worker-sysbox/worker.ts`) overrides the
# Entrypoint/Cmd at create-container time; the default below is for
# `docker run` smoke tests. WORKDIR is the user's home so any temp
# files the skill writes land somewhere writable.
USER cogmo
WORKDIR /home/cogmo
CMD ["python3", "-I", "-u", "-m", "cogmo_skills_runtime"]
