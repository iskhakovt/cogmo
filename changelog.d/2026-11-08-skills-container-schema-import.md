A container-tier skill's pydantic models are now its schemas too (design/skills.md → Contracts).

- Register imports a container skill in a session of the skills image created with no network, which runs `python3 -I -m cogmo_skills_runtime.schema` under the skill's resources and wall clock. With dependencies, an install session with network and the shared venv volume populates the lockfile's venv first, and the import activates it. Dependencies that do not install are rejected as `schema_import_failed`, as is a skill that does not load. A session that does not start or finish is rejected as `schema_import_unavailable`.
- A backend that creates no session with no network (`SandboxCapabilities.noNetworkSessions`; Daytona) keeps the frontmatter, and so does a skill with dependencies where no shared venv volume is configured.
- The register-time lockfile compile mounts no venv volume, since resolving can run a dependency's build backend.
- Both tiers' import replies share one schema, `schema_import_reply` in the generated worker protocol.
