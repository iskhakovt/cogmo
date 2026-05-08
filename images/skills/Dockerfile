# cogmo-skills — base task-container image for tier-2 (sysbox) skills.
#
# Built and published as the `skills` target of `/docker-bake.hcl` by
# .github/workflows/publish.yml at every cogmo release. Tag tracks the
# cogmo app version. See `design/skills.md` → "Tier 2 — Sysbox container"
# for the contract.
#
# Today's image is intentionally minimal — Python runtime + non-root user.
# We own the pipeline; deps land here as real skills demand them (s3fs-fuse
# for the future POSIX shim, common pip wheels once we know which actually
# save cold-start time).

FROM mirror.gcr.io/library/python:3.14-slim@sha256:5b3879b6f3cb77e712644d50262d05a7c146b7312d784a18eff7ff5462e77033

# Non-root user. Sysbox already maps the in-container root to a non-root
# host uid via user namespaces, so this is defense in depth + parity with
# `cogmo-devbase`'s `vscode` user.
RUN useradd -r -m -u 1000 -s /bin/bash cogmo

# `python3 -u -c <runner>` is invoked by the host with stdin attached; the
# image's default entrypoint is irrelevant. Cogmo's supervisor overrides
# Entrypoint/Cmd at create-container time. WORKDIR is the user's home so
# any temp files the skill writes land somewhere writable.
USER cogmo
WORKDIR /home/cogmo
