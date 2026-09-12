### `pnpm test:e2e` builds its own image again

`test/e2e-setup.ts` builds the app image when `E2E_IMAGE` is unset, and passes the repo root as the build context. The Dockerfile's first `COPY` takes the workspace manifests and then descends into `apps/`, and `.dockerignore`'s allowlist is written against the same root, so that is the directory the build has to start from.

Vitest runs with the cwd set to the package that owns the config — `apps/server` — which holds neither file. CI never meets this: its e2e job bakes the image first and passes `E2E_IMAGE`, leaving the build branch unreached. The documented local command, `pnpm test:e2e` on its own, is the one that takes it.

`src/test/repo-root.ts` owns the resolution as `repoRoot()`, walking up to `pnpm-workspace.yaml` rather than counting `../`, so the answer holds wherever the caller sits. It replaces three byte-identical copies of that walk in `engine-ranges`, `version-pins` and `skill-authoring`, and backs `loadRootEnv`, which needs the same root for the repo's `.env`.

`src/test/repo-root.test.ts` is the layout canary. The consumers outside `src/` both fail quietly when the path is wrong — an absent `.env` reads as "not recording" and returns, and the image build sits behind a branch CI always skips — so the guard asserts against real files instead: `Dockerfile`, `.dockerignore`, and `apps/server/package.json` below the root.

### Local integration runs need container-to-host loopback

`design/testing.md` records what the Hindsight container needs in order to reach llmock on the host. Rootless Docker blocks that by default via `rootlesskit --disable-host-loopback`, and the symptom points nowhere near the network: Hindsight reports `Failed to generate batch embeddings: Connection error` and the memory-backed tests fail. `DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false` on the daemon is the knob.
