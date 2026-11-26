import { describe, expect, it } from "vitest";
import { assertKind } from "../../test/assertions.js";
import { rejectionStatus } from "./rejection.js";
import { classify } from "./router.js";

describe("router.classify", () => {
  describe("deny set", () => {
    it.each([
      ["/swarm", "GET"],
      ["/swarm/init", "POST"],
      ["/v1.43/swarm/inspect", "GET"],
      ["/plugins", "GET"],
      ["/plugins/foo/enable", "POST"],
      ["/v1.43/plugins/foo/disable", "POST"],
      ["/nodes", "GET"],
      ["/v1.43/nodes/abc", "DELETE"],
    ])("denies %s (%s)", (path, method) => {
      const r = classify(method, path);
      assertKind(r, "reject");
      expect(rejectionStatus(r.rejection)).toBe(403);
    });

    it("does NOT deny things that merely substring-contain swarm/plugins/nodes", () => {
      // `/containers/swarm-leader/json` shouldn't match the swarm prefix
      // because the prefix is segment-aware.
      expect(classify("GET", "/containers/swarm-leader/json").kind).toBe("forward");
      expect(classify("GET", "/containers/my-plugin/json").kind).toBe("forward");
      expect(classify("GET", "/networks/my-nodes/inspect").kind).toBe("forward");
    });

    it("denies percent-encoded slash variants (%2F)", () => {
      // Docker decodes these on its end, so the proxy has to canonicalise
      // before the deny check or the encoded variant slips past.
      expect(classify("GET", "/v1.43/swarm%2Finit").kind).toBe("reject");
      expect(classify("GET", "%2Fswarm").kind).toBe("reject");
      expect(classify("POST", "/v1.43/plugins%2Ffoo%2Fenable").kind).toBe("reject");
    });

    it("denies path-traversal variants", () => {
      expect(classify("GET", "/swarm/./inspect").kind).toBe("reject");
      expect(classify("GET", "/foo/../swarm/init").kind).toBe("reject");
      expect(classify("GET", "//swarm/init").kind).toBe("reject");
    });

    it("denies backslash variants (windows-style separators)", () => {
      expect(classify("GET", "\\swarm\\init").kind).toBe("reject");
    });
  });

  describe("container_create", () => {
    it.each([
      ["/containers/create", ""],
      ["/v1.44/containers/create", "/v1.44"],
      ["/v1.52/containers/create", "/v1.52"],
      ["/v1.999/containers/create", "/v1.999"],
      ["/v2/containers/create", "/v2"],
      ["/v1.44//containers/./create", "/v1.44"],
    ])("POST %s keeps the version prefix %j", (path, versionPrefix) => {
      expect(classify("POST", path)).toEqual({ kind: "container_create", versionPrefix });
    });

    it("query string doesn't affect classification", () => {
      expect(classify("POST", "/containers/create?name=foo").kind).toBe("container_create");
    });

    it("GET /containers/create is forward (no such Docker endpoint, but our classifier doesn't 404)", () => {
      expect(classify("GET", "/containers/create").kind).toBe("forward");
    });
  });

  describe("exec_create", () => {
    it.each([
      "/containers/abc/exec",
      "/v1.44/containers/abc/exec",
      "/containers/abc%2Fexec",
      "/containers/parent/alias/exec",
    ])("POST %s", (path) => {
      expect(classify("POST", path).kind).toBe("exec_create");
    });

    it("GET /containers/abc/exec is forward", () => {
      expect(classify("GET", "/containers/abc/exec").kind).toBe("forward");
    });
  });

  describe("API version floor on the create and exec routes", () => {
    it.each([
      ["POST", "/v1.43/containers/create"],
      ["POST", "/v1.4/containers/create"],
      ["POST", "/v1/containers/create"],
      ["POST", "/v1.43.9/containers/create"],
      ["POST", "/v0.99/containers/abc/exec"],
      ["POST", "/v1.43/containers/abc/exec"],
      ["POST", "/v1.99999999999999999999/containers/create"],
    ])("denies %s %s", (method, path) => {
      const r = classify(method, path);
      assertKind(r, "reject");
      expect(rejectionStatus(r.rejection)).toBe(403);
    });

    it.each([
      ["GET", "/v1.24/containers/json"],
      ["POST", "/v1.24/containers/abc/start"],
      ["POST", "/v1.24/exec/abc/start"],
    ])("leaves %s %s to its route", (method, path) => {
      expect(classify(method, path).kind).not.toBe("reject");
    });
  });

  describe("hijack set", () => {
    it.each([
      ["POST", "/exec/abc/start"],
      ["POST", "/v1.43/exec/abc/start"],
      ["POST", "/containers/abc/attach"],
      ["POST", "/v1.43/containers/abc/attach"],
      ["GET", "/containers/abc/logs?follow=1&stdout=1"],
      ["GET", "/v1.43/containers/abc/logs"],
      ["GET", "/events"],
      ["GET", "/v1.43/events?since=0"],
    ])("hijacks %s %s", (method, path) => {
      expect(classify(method, path).kind).toBe("hijack");
    });

    it.each([
      ["POST", "/build"],
      ["POST", "/v1.43/build"],
      ["POST", "/session"],
      ["POST", "/v1.43/session"],
      ["POST", "/auth"],
      ["POST", "/v1.43/auth"],
    ])("denies %s %s (image production / registry auth — see DENY_PREFIXES)", (method, path) => {
      const r = classify(method, path);
      expect(r.kind).toBe("reject");
    });
  });

  describe("forward (default)", () => {
    it.each([
      ["GET", "/_ping"],
      ["GET", "/version"],
      ["GET", "/info"],
      ["GET", "/containers/json"],
      ["GET", "/containers/abc/json"],
      ["POST", "/containers/abc/start"],
      ["POST", "/containers/abc/stop"],
      ["DELETE", "/containers/abc"],
      ["POST", "/networks/create"],
      ["DELETE", "/networks/abc"],
      ["POST", "/volumes/create"],
      ["DELETE", "/volumes/foo"],
      ["GET", "/images/json"],
      ["POST", "/images/create"],
      ["GET", "/system/df"],
    ])("forwards %s %s", (method, path) => {
      expect(classify(method, path).kind).toBe("forward");
    });
  });
});
