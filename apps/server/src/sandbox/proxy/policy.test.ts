import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyContainerCreatePolicy } from "./policy.js";
import type { TaskScope } from "./types.js";

// Subset of the Docker /containers/create body the policy tests assert on.
const DecodedBodySchema = z
  .object({
    Image: z.string().optional(),
    HostConfig: z
      .object({
        Runtime: z.string().optional(),
        CgroupParent: z.string().optional(),
      })
      .passthrough()
      .optional()
      .default({}),
    Labels: z.record(z.string(), z.string()).optional().default({}),
  })
  .passthrough();

const SCOPE: TaskScope = {
  taskId: "019d0000-0000-7000-8000-00000000aaaa",
  parentContainerRowId: "019d0000-0000-7000-8000-00000000bbbb",
  parentDockerId: "docker-parent-abc",
  parentDepth: 0,
  runtime: "sysbox-runc",
  cgroupParent: "cogmo-task-abc.slice",
  instanceId: "019d0000-0000-7000-8000-0000000000ff",
};

function body(spec: object): Buffer {
  return Buffer.from(JSON.stringify(spec), "utf8");
}

function decode(buf: Buffer): z.infer<typeof DecodedBodySchema> {
  return DecodedBodySchema.parse(JSON.parse(buf.toString("utf8")));
}

describe("applyContainerCreatePolicy", () => {
  describe("denies", () => {
    it("rejects malformed JSON", () => {
      const r = applyContainerCreatePolicy(Buffer.from("not json"), SCOPE);
      expect(r.kind).toBe("deny");
      if (r.kind !== "deny") return;
      expect(r.status).toBe(400);
    });

    it("rejects non-object body", () => {
      const r = applyContainerCreatePolicy(body([]), SCOPE);
      expect(r.kind).toBe("deny");
    });

    it("rejects HostConfig.Privileged=true", () => {
      const r = applyContainerCreatePolicy(body({ HostConfig: { Privileged: true } }), SCOPE);
      expect(r.kind).toBe("deny");
      if (r.kind !== "deny") return;
      expect(r.status).toBe(403);
      expect(r.message).toContain("Privileged");
    });

    it("allows HostConfig.Privileged=false (default)", () => {
      expect(
        applyContainerCreatePolicy(body({ HostConfig: { Privileged: false } }), SCOPE).kind,
      ).toBe("allow");
    });

    it("rejects NetworkMode=host", () => {
      const r = applyContainerCreatePolicy(body({ HostConfig: { NetworkMode: "host" } }), SCOPE);
      expect(r.kind).toBe("deny");
      if (r.kind !== "deny") return;
      expect(r.message).toContain('"host"');
    });

    it("allows NetworkMode=bridge / container:foo / a custom network name", () => {
      for (const mode of ["bridge", "container:foo", "my-network"]) {
        expect(
          applyContainerCreatePolicy(body({ HostConfig: { NetworkMode: mode } }), SCOPE).kind,
        ).toBe("allow");
      }
    });

    it.each([
      "/etc:/host-etc",
      "/var:/var:ro",
      "/home/user/secrets:/secrets",
      "/:/host-root",
    ])("rejects host-path bind %s", (bind) => {
      const r = applyContainerCreatePolicy(body({ HostConfig: { Binds: [bind] } }), SCOPE);
      expect(r.kind).toBe("deny");
    });

    it("allows named-volume binds", () => {
      const r = applyContainerCreatePolicy(
        body({ HostConfig: { Binds: ["myvol:/inside", "cache:/cache:rw"] } }),
        SCOPE,
      );
      expect(r.kind).toBe("allow");
    });

    it("rejects HostConfig.Mounts type=bind with a host-path Source", () => {
      const r = applyContainerCreatePolicy(
        body({
          HostConfig: {
            Mounts: [{ Type: "bind", Source: "/etc", Target: "/host-etc" }],
          },
        }),
        SCOPE,
      );
      expect(r.kind).toBe("deny");
      if (r.kind !== "deny") return;
      expect(r.message).toContain("/etc");
    });

    it("allows HostConfig.Mounts type=volume (named volume, no host path)", () => {
      const r = applyContainerCreatePolicy(
        body({
          HostConfig: {
            Mounts: [{ Type: "volume", Source: "myvol", Target: "/data" }],
          },
        }),
        SCOPE,
      );
      expect(r.kind).toBe("allow");
    });

    it("allows HostConfig.Mounts type=tmpfs", () => {
      const r = applyContainerCreatePolicy(
        body({
          HostConfig: { Mounts: [{ Type: "tmpfs", Target: "/scratch" }] },
        }),
        SCOPE,
      );
      expect(r.kind).toBe("allow");
    });

    it("rejects HostConfig.Mounts type=bind with empty Source", () => {
      const r = applyContainerCreatePolicy(
        body({
          HostConfig: { Mounts: [{ Type: "bind", Source: "", Target: "/x" }] },
        }),
        SCOPE,
      );
      expect(r.kind).toBe("deny");
    });

    it.each([
      "SYS_ADMIN",
      "CAP_SYS_ADMIN",
      "NET_ADMIN",
      "SYS_PTRACE",
      "SYS_MODULE",
      "MAC_OVERRIDE",
    ])("rejects CapAdd containing %s", (cap) => {
      const r = applyContainerCreatePolicy(body({ HostConfig: { CapAdd: [cap] } }), SCOPE);
      expect(r.kind).toBe("deny");
      if (r.kind !== "deny") return;
      expect(r.message).toContain(cap);
    });

    it("allows benign CapAdd entries", () => {
      const r = applyContainerCreatePolicy(
        body({ HostConfig: { CapAdd: ["CHOWN", "SETUID", "SETGID", "NET_BIND_SERVICE"] } }),
        SCOPE,
      );
      expect(r.kind).toBe("allow");
    });
  });

  describe("mutations", () => {
    it("injects runtime + cgroupParent + Cogmo labels", () => {
      const r = applyContainerCreatePolicy(body({ Image: "alpine" }), SCOPE);
      expect(r.kind).toBe("allow");
      if (r.kind !== "allow") return;
      const out = decode(r.body);
      expect(out.HostConfig.Runtime).toBe("sysbox-runc");
      expect(out.HostConfig.CgroupParent).toBe("cogmo-task-abc.slice");
      expect(out.Labels).toEqual({
        "cogmo.managed": "true",
        "cogmo.instance": SCOPE.instanceId,
        "cogmo.root_task": SCOPE.taskId,
        "cogmo.parent": "docker-parent-abc",
        "cogmo.depth": "1",
      });
    });

    it("overrides runtime even if the caller sets it explicitly", () => {
      const r = applyContainerCreatePolicy(body({ HostConfig: { Runtime: "runc" } }), SCOPE);
      if (r.kind !== "allow") throw new Error("expected allow");
      const out = decode(r.body);
      expect(out.HostConfig.Runtime).toBe("sysbox-runc");
    });

    it("overrides cgroupParent if the caller sets it explicitly", () => {
      const r = applyContainerCreatePolicy(
        body({ HostConfig: { CgroupParent: "/some-other-cgroup" } }),
        SCOPE,
      );
      if (r.kind !== "allow") throw new Error("expected allow");
      const out = decode(r.body);
      expect(out.HostConfig.CgroupParent).toBe("cogmo-task-abc.slice");
    });

    it("overwrites cogmo.* labels but preserves user labels", () => {
      const r = applyContainerCreatePolicy(
        body({
          Labels: {
            "user.foo": "bar",
            "cogmo.parent": "spoofed-parent",
            "cogmo.managed": "false",
          },
        }),
        SCOPE,
      );
      if (r.kind !== "allow") throw new Error("expected allow");
      const out = decode(r.body);
      expect(out.Labels["user.foo"]).toBe("bar");
      expect(out.Labels["cogmo.parent"]).toBe("docker-parent-abc");
      expect(out.Labels["cogmo.managed"]).toBe("true");
    });

    it("computes cogmo.depth from parent depth + 1", () => {
      const scope: TaskScope = { ...SCOPE, parentDepth: 3 };
      const r = applyContainerCreatePolicy(body({}), scope);
      if (r.kind !== "allow") throw new Error("expected allow");
      const out = decode(r.body);
      expect(out.Labels["cogmo.depth"]).toBe("4");
    });

    it("respects scope.runtime = runc", () => {
      const scope: TaskScope = { ...SCOPE, runtime: "runc" };
      const r = applyContainerCreatePolicy(body({}), scope);
      if (r.kind !== "allow") throw new Error("expected allow");
      const out = decode(r.body);
      expect(out.HostConfig.Runtime).toBe("runc");
    });
  });
});
