The hand-pinned dependencies move to pnpm 12.20.0, uv 0.13.8, the dev shell's nixpkgs (Node 26.13.1), the skills repo toolchain's Python dev tools (pyrefly 1.4.1, ruff 0.17.5, pytest-asyncio 1.5.0), the test images Inngest v1.52.0, RustFS 1.0.5 and Hindsight 1.2.1, and in CI `@semantic-release/github` 12.0.11 and dunamai 1.26.5. The bundled model snapshot is refreshed to 4571 entries.

ruff 0.17.5's B008 accepts a frozen dataclass instance as a default, so a skill's `# noqa: B008` on one becomes a `RUF100` finding on its next tip.
