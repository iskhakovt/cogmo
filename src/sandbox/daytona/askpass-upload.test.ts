import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox as DaytonaSdkSandbox } from "@daytonaio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadAskpassToSandbox } from "./askpass-upload.js";

let hostDir: string;

const fsCalls = {
  uploadFiles: vi.fn<(...args: unknown[]) => Promise<void>>(),
  setFilePermissions: vi.fn<(...args: unknown[]) => Promise<void>>(),
};

function fakeSandbox(): DaytonaSdkSandbox {
  return {
    id: "sb-test",
    fs: {
      uploadFiles: fsCalls.uploadFiles,
      setFilePermissions: fsCalls.setFilePermissions,
    },
  } as unknown as DaytonaSdkSandbox;
}

beforeEach(() => {
  hostDir = mkdtempSync(join(tmpdir(), "cogmo-askpass-test-"));
  // Mirror the layout `provisionAskpass` writes — content is deliberately
  // distinguishable so the upload assertions can spot file-name mixups.
  writeFileSync(join(hostDir, "helper"), "#!/bin/sh\nexec /bin/cat /tmp/pat\n");
  writeFileSync(join(hostDir, "pat"), "ghp_test_pat_value");
  writeFileSync(join(hostDir, "signing-key"), "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n");
  writeFileSync(join(hostDir, "signing-key.pub"), "ssh-ed25519 AAAA... cogmo-bot\n");

  fsCalls.uploadFiles.mockReset();
  fsCalls.setFilePermissions.mockReset();
});

afterEach(() => {
  rmSync(hostDir, { recursive: true, force: true });
});

describe("uploadAskpassToSandbox", () => {
  it("uploads the four askpass files in one fs.uploadFiles call", async () => {
    await uploadAskpassToSandbox({
      sandbox: fakeSandbox(),
      hostDir,
      containerDir: "/.cogmo-askpass",
    });

    expect(fsCalls.uploadFiles).toHaveBeenCalledTimes(1);
    const uploads = fsCalls.uploadFiles.mock.calls[0]?.[0] as Array<{
      source: Buffer;
      destination: string;
    }>;
    const destinations = uploads.map((u) => u.destination).sort();
    expect(destinations).toEqual([
      "/.cogmo-askpass/helper",
      "/.cogmo-askpass/pat",
      "/.cogmo-askpass/signing-key",
      "/.cogmo-askpass/signing-key.pub",
    ]);
    // Source bytes match disk content — ssh-keygen and the helper both
    // care about exact contents (newlines, etc.).
    const byName = Object.fromEntries(
      uploads.map((u) => [u.destination.split("/").pop(), u.source.toString("utf8")]),
    );
    expect(byName.pat).toBe("ghp_test_pat_value");
    expect(byName.helper?.startsWith("#!/bin/sh")).toBe(true);
    expect(byName["signing-key"]?.includes("BEGIN OPENSSH")).toBe(true);
  });

  it("applies the per-file modes ssh-keygen -Y sign and the helper require", async () => {
    await uploadAskpassToSandbox({
      sandbox: fakeSandbox(),
      hostDir,
      containerDir: "/.cogmo-askpass",
    });

    const modes = fsCalls.setFilePermissions.mock.calls.map((args) => ({
      path: args[0] as string,
      mode: (args[1] as { mode: string }).mode,
    }));
    expect(modes).toEqual([
      { path: "/.cogmo-askpass/helper", mode: "755" },
      { path: "/.cogmo-askpass/pat", mode: "644" },
      // 600 is non-negotiable — ssh-keygen -Y sign refuses to load a
      // private key with broader permissions.
      { path: "/.cogmo-askpass/signing-key", mode: "600" },
      { path: "/.cogmo-askpass/signing-key.pub", mode: "644" },
    ]);
  });

  it("propagates upload failures (caller rolls back the sandbox)", async () => {
    fsCalls.uploadFiles.mockRejectedValue(new Error("network blip"));
    await expect(
      uploadAskpassToSandbox({
        sandbox: fakeSandbox(),
        hostDir,
        containerDir: "/.cogmo-askpass",
      }),
    ).rejects.toThrow(/network blip/);
    // No permissions calls when the upload itself failed — nothing to chmod.
    expect(fsCalls.setFilePermissions).not.toHaveBeenCalled();
  });
});
