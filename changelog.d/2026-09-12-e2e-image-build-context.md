### `pnpm test:e2e` builds its own image from the repo root

`test/e2e-setup.ts` builds the app image when `E2E_IMAGE` is unset, and passes the repo root as the build context. That is the only directory the build can start from: the Dockerfile's first `COPY` takes the workspace manifests and then descends into `apps/`, and `.dockerignore`'s allowlist is written against the same root.

The root has to be named explicitly because Vitest runs with the cwd set to the package that owns the config — `apps/server` — which holds neither file. CI passes `E2E_IMAGE` from its bake step, so this branch belongs to local runs alone, and `pnpm test:e2e` on its own is what reaches it.

`src/test/repo-root.ts` owns the resolution as `repoRoot()`, walking up to `pnpm-workspace.yaml` rather than counting `../`, so the answer holds wherever the caller sits. `engine-ranges`, `version-pins`, `skill-authoring` and `loadRootEnv` all share it.

`src/test/repo-root.test.ts` is the layout canary. The consumers outside `src/` both fail quietly on a wrong path — an absent `.env` reads as "not recording" and returns, and the image build sits behind a branch CI skips — so the guard asserts against real files: `Dockerfile`, `.dockerignore`, and `apps/server/package.json` below the root.

### Local integration runs need container-to-host loopback

`design/testing.md` records what the Hindsight container needs in order to reach llmock on the host. Rootless Docker blocks that by default via `rootlesskit --disable-host-loopback`, and the symptom points nowhere near the network: Hindsight reports `Failed to generate batch embeddings: Connection error` and the memory-backed tests fail. `DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false` on the daemon is the knob.
