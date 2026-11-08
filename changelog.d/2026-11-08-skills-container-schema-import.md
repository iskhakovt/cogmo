A container-tier skill's pydantic models are now its schemas too (design/skills.md → Contracts).

- Register imports a container skill in a session of the skills image created with no network, which runs `python3 -I -m cogmo_skills_runtime.schema` under the skill's resources and wall clock. With dependencies, an install session with network and the shared venv volume populates the lockfile's venv first, and the import activates it. Dependencies that do not install are rejected as `schema_import_failed`, as is a skill that does not load. A session that does not start or finish is rejected as `schema_import_unavailable`.
- A backend that creates no session with no network (`SandboxCapabilities.noNetworkSessions`; Daytona) keeps the frontmatter, and so does a skill with dependencies where no shared venv volume is configured.
- The register-time lockfile compile mounts no venv volume, since resolving can run a dependency's build backend.
- Both tiers' import replies share one schema, `schema_import_reply` in the generated worker protocol.
- `SUPERVISOR_PROTOCOL_VERSION` is 7, since the host runs a new module in the image: the container tier needs the `cogmo-skills` image of this release, and an older one fails worker creation and is refused at register.
- The lockfile compile's session takes a bare UUID as its task id, which Local-Docker names the session's cgroup slice after, so registering a skill with dependencies there no longer fails before the compile runs.
