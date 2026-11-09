Cogmo commits a toolchain to the skills repo (design/skills.md → Verify stage → The skills repo toolchain).

- **Toolchain entries.** There are five root entries: `pyproject.toml`, `uv.lock`, `CLAUDE.md`, `.gitignore` and `.cogmo/`.
  - All but `.cogmo/cogmo_ctx/` are checked in under `images/skills/toolchain/`, generated where derived, with drift tests. `cogmo_ctx/` is joined from `images/skills/src/` when the boot reads the toolchain.
  - `pyproject.toml` pins the dev tools and the image's uv (`required-version`), and sets `[tool.uv.pip]` so a plain `uv pip compile` writes register's bytes for the image's Python.
  - CI checks that `uv.lock` is current.
- **Boot commit.** At boot, after the layout move, Cogmo compares those entries on `main` with the release's and commits the release's when any differs.
  - The commit removes entries the release no longer lists.
  - It refuses a `.cogmo/paths` that names `skills`, a skill file, `.`, `..`, `.git` or a nested path.
- **Adopting a remote.** A `main` holding only Cogmo's commits (the bare layout commit, then toolchain commits) counts as unborn.
  - Every adopt fetches to a side ref and refuses a remote whose `.cogmo/paths` is invalid (`remote_toolchain_invalid`).
  - `cogmo migrate-skills-remote` and the setup wizard hold the bootstrap lock through the adopt's toolchain commit.
- **Not wired yet.** `.cogmo/verify` checks the skills a coding task changed, but coding tasks don't run it: the repo's verify command is still `true`.
