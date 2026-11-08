**Claude Code 2.1.311 in the devbase image**, the CLI's `stable` dist-tag. With background tasks off it still exits at its `result` when a background command is left running.

The other hand-pinned dependencies: pnpm 12.17.0, the dev shell's nixpkgs (Node stays 26.13.0), the gitea test image 28.3.0, the skills runtime's Python dev tools (pyrefly 1.4.0, ruff 0.17.3, pytest 9.2.0, pytest-asyncio 1.4.1), and in CI commitlint 21.2.4, `@semantic-release/github` 12.0.10 and dunamai 1.26.3.
