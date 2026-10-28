import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";
import { mirrorMainToRemote } from "./mirror.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("mirrorMainToRemote", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("logs a failed origin lookup instead of throwing after a committed deploy", async () => {
    // Not a git repository: `git remote get-url origin` fails with a code
    // other than the "no such remote" one, which the lookup rethrows.
    dir = await mkdtemp(join(tmpdir(), "cogmo-mirror-test-"));
    await expect(
      mirrorMainToRemote(
        { runInTx: fakeRunInTx, secretsStore: mock<SecretsStore>() },
        dir,
        "0123456789abcdef0123456789abcdef01234567",
      ),
    ).resolves.toBeUndefined();
  });
});
