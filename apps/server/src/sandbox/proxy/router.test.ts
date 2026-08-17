import { describe, expect, it } from "vitest";
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
      expect(r.kind).toBe("deny");
      if (r.kind !== "deny") return;
      expect(r.status).toBe(403);
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
      expect(classify("GET", "/v1.43/swarm%2Finit").kind).toBe("deny");
      expect(classify("GET", "%2Fswarm").kind).toBe("deny");
      expect(classify("POST", "/v1.43/plugins%2Ffoo%2Fenable").kind).toBe("deny");
    });

    it("denies path-traversal variants", () => {
      expect(classify("GET", "/swarm/./inspect").kind).toBe("deny");
      expect(classify("GET", "/foo/../swarm/init").kind).toBe("deny");
      expect(classify("GET", "//swarm/init").kind).toBe("deny");
    });

    it("denies backslash variants (windows-style separators)", () => {
      expect(classify("GET", "\\swarm\\init").kind).toBe("deny");
    });
  });

  describe("policy: container_create", () => {
    it.each(["/containers/create", "/v1.43/containers/create", "/v1.999/containers/create"])(
      "policy on POST %s",
      (path) => {
        const r = classify("POST", path);
        expect(r.kind).toBe("policy");
        if (r.kind !== "policy") return;
        expect(r.subject).toBe("container_create");
      },
    );

    it("query string doesn't affect classification", () => {
      const r = classify("POST", "/containers/create?name=foo");
      expect(r.kind).toBe("policy");
    });

    it("GET /containers/create is forward (no such Docker endpoint, but our classifier doesn't 404)", () => {
      expect(classify("GET", "/containers/create").kind).toBe("forward");
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
      expect(r.kind).toBe("deny");
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
