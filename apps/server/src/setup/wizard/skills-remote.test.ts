import * as p from "@clack/prompts";
import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapLock } from "../../db/bootstrap-lock.js";
import { buildWizardDeps, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureSkillsRemote } from "./skills-remote.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const {
  bootstrapSkillsRepoSpy,
  readOriginUrlSpy,
  ensureSkillsCodingRepoSpy,
  configureSkillsRemoteSpy,
} = vi.hoisted(() => ({
  bootstrapSkillsRepoSpy: vi.fn(),
  readOriginUrlSpy: vi.fn(),
  ensureSkillsCodingRepoSpy: vi.fn(),
  configureSkillsRemoteSpy: vi.fn(),
}));

vi.mock("../../skills/repo.js", () => ({
  bootstrapSkillsRepo: bootstrapSkillsRepoSpy,
  readOriginUrl: readOriginUrlSpy,
  ensureSkillsCodingRepo: ensureSkillsCodingRepoSpy,
  SKILLS_CODING_REPO_NAME: "skills",
}));

vi.mock("../../skills/configure-remote.js", () => ({
  configureSkillsRemote: configureSkillsRemoteSpy,
  AUTO_PROVISION_REPO_NAME: "cogmo-skills",
}));

vi.mock("../../skills/configure-remote-prompts.js", () => ({
  collectSkillsRemoteMode: vi.fn().mockResolvedValue({ kind: "skip" }),
  renderConfigureError: vi.fn(),
  readLocalMainSha: vi.fn(async () => null),
}));

vi.mock("../../agent/coding/store/index.js", () => ({
  DrizzleCodingStore: class {},
}));

/** Whether `recordingLock` is held right now. */
let lockHeld = false;
const recordingLock: BootstrapLock = async (fn) => {
  lockHeld = true;
  try {
    return await fn();
  } finally {
    lockHeld = false;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  bootstrapSkillsRepoSpy.mockReset();
  readOriginUrlSpy.mockReset();
  ensureSkillsCodingRepoSpy.mockReset();
  configureSkillsRemoteSpy.mockReset();
});

describe("stepConfigureSkillsRemote", () => {
  it("initializes the bare repo under the bootstrap lock", async () => {
    // Two first-time inits on one path can fail on git's config lock;
    // `cogmo serve` initializes under the same lock.
    const deps = buildWizardDeps(recordingLock);
    let heldDuringInit: boolean | undefined;
    bootstrapSkillsRepoSpy.mockImplementationOnce(async () => {
      heldDuringInit = lockHeld;
      return { initialized: true };
    });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(ok({ kind: "skipped" }));

    await stepConfigureSkillsRemote(deps);

    expect(heldDuringInit).toBe(true);
  });

  it("releases the bootstrap lock before prompting", async () => {
    // A held lock would stall every concurrent boot until the operator answers.
    const deps = buildWizardDeps(recordingLock);
    let heldAtPrompt: boolean | undefined;
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce("git@github.com:me/cogmo-skills.git");
    vi.mocked(p.select).mockImplementationOnce(async () => {
      heldAtPrompt = lockHeld;
      return "keep";
    });
    ensureSkillsCodingRepoSpy.mockResolvedValueOnce({ kind: "unchanged" });

    await stepConfigureSkillsRemote(deps);

    expect(heldAtPrompt).toBe(false);
  });

  it("when origin is already set and operator picks 'keep', syncs DB row and returns", async () => {
    const deps = buildWizardDeps(recordingLock);
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce("git@github.com:me/cogmo-skills.git");
    vi.mocked(p.select).mockResolvedValueOnce("keep");
    ensureSkillsCodingRepoSpy.mockResolvedValueOnce({ kind: "unchanged" });

    await stepConfigureSkillsRemote(deps);

    expect(ensureSkillsCodingRepoSpy).toHaveBeenCalled();
    expect(configureSkillsRemoteSpy).not.toHaveBeenCalled();
  });

  it("when 'replace' is selected, falls through to collectSkillsRemoteMode and configureSkillsRemote", async () => {
    const deps = buildWizardDeps(recordingLock);
    const { collectSkillsRemoteMode } = await import("../../skills/configure-remote-prompts.js");
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: true });
    readOriginUrlSpy.mockResolvedValueOnce("git@github.com:me/cogmo-skills.git");
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(collectSkillsRemoteMode).mockResolvedValueOnce({
      kind: "own",
      direction: "publish",
      remoteUrl: "git@github.com:new/cogmo-skills.git",
    });
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      ok({
        kind: "configured",
        remoteUrl: "git@github.com:new/cogmo-skills.git",
        direction: "publish",
        originAction: "updated",
        ensured: { kind: "created" },
        backupPath: "/tmp/backup-1.json",
      }),
    );

    await stepConfigureSkillsRemote(deps);

    expect(configureSkillsRemoteSpy).toHaveBeenCalled();
  });

  it("warns and returns when configureSkillsRemote yields {kind:'skipped'}", async () => {
    const deps = buildWizardDeps(recordingLock);
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(ok({ kind: "skipped" }));

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/Skills remote not configured/),
    );
  });

  it("renders the error when configureSkillsRemote returns Err", async () => {
    const deps = buildWizardDeps(recordingLock);
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      err({ kind: "url_invalid", remoteUrl: "x", reason: "bad" }),
    );
    const { renderConfigureError } = await import("../../skills/configure-remote-prompts.js");

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(renderConfigureError)).toHaveBeenCalled();
  });

  it("logs the success message with 'published to' when direction is 'publish'", async () => {
    const deps = buildWizardDeps(recordingLock);
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      ok({
        kind: "configured",
        remoteUrl: "git@github.com:me/cogmo-skills.git",
        direction: "publish",
        originAction: "attached",
        ensured: { kind: "created" },
        backupPath: null,
      }),
    );

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.success)).toHaveBeenCalledWith(
      expect.stringMatching(/Skills remote published to:/),
    );
  });

  it("logs the success message with 'adopted from' when direction is 'adopt'", async () => {
    const deps = buildWizardDeps(recordingLock);
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      ok({
        kind: "configured",
        remoteUrl: "git@github.com:me/cogmo-skills.git",
        direction: "adopt",
        originAction: "attached",
        ensured: { kind: "created" },
        backupPath: "/tmp/b",
      }),
    );

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.success)).toHaveBeenCalledWith(
      expect.stringMatching(/Skills remote adopted from:/),
    );
  });

  it("reports bare-repo initialization when bootstrapSkillsRepo returns initialized:true", async () => {
    const deps = buildWizardDeps(recordingLock);
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: true });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(ok({ kind: "skipped" }));

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.info)).toHaveBeenCalledWith(
      expect.stringMatching(/Initialized bare skills repo/),
    );
  });
});
