# cogmo/skills:slice1 — base task-container image for tier-2 (sysbox) skills.
#
# Built and published from this directory by .github/workflows/skills.yml via
# the `skills` target in `/docker-bake.hcl`. See `design/skills.md` →
# "Tier 2 — Sysbox container" for the contract.
#
# Slice 1 is intentionally minimal — just the Python runtime and a non-root
# user. We own the pipeline + tag pinning; deps land here as real skills
# demand them (s3fs-fuse for the future POSIX shim, common pip wheels once
# we know which actually save cold-start time).

FROM python:3.14-slim

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
