import { describe, expect, it } from "vitest";
import { assertKind } from "../../test/assertions.js";
import { rejectionMessage, rejectionStatus } from "./rejection.js";
import { classify } from "./router.js";

function rejectedStatus(method: string, path: string): number {
  const r = classify(method, path);
  assertKind(r, "reject");
  return rejectionStatus(r.rejection);
}

describe("router.classify", () => {
  describe("default deny", () => {
    it.each([
      ["GET", "/swarm"],
      ["POST", "/swarm/init"],
      ["GET", "/v1.44/swarm/inspect"],
      ["GET", "/plugins"],
      ["POST", "/plugins/foo/enable"],
      ["GET", "/nodes"],
      ["DELETE", "/v1.44/nodes/abc"],
      ["POST", "/build"],
      ["POST", "/session"],
      ["POST", "/grpc"],
      ["POST", "/auth"],
      ["GET", "/containers/create"],
      ["GET", "/containers/abc/exec"],
      ["POST", "/containers/abc/update"],
      ["POST", "/containers/prune"],
      ["GET", "/system/df"],
      ["PUT", "/volumes/v1"],
      ["DELETE", "/volumes/v1"],
      ["GET", "/foo"],
    ])("denies %s %s", (method, path) => {
      expect(rejectedStatus(method, path)).toBe(403);
    });

    it("names the method and canonical route of an unlisted path", () => {
      const r = classify("get", "/v1.44//foo/./bar?x=1");
      assertKind(r, "reject");
      expect(rejectionMessage(r.rejection)).toContain("GET /foo/bar");
    });

    it("does not deny things that merely substring-contain a denied family", () => {
      expect(classify("GET", "/containers/swarm-leader/json").kind).toBe("request");
      expect(classify("GET", "/containers/my-plugin/json").kind).toBe("request");
      expect(classify("GET", "/networks/my-nodes").kind).toBe("request");
    });

    it("denies percent-encoded slash variants (%2F)", () => {
      expect(rejectedStatus("GET", "/v1.44/swarm%2Finit")).toBe(403);
      expect(rejectedStatus("GET", "%2Fswarm")).toBe(403);
      expect(rejectedStatus("POST", "/v1.44/plugins%2Ffoo%2Fenable")).toBe(403);
    });

    it("denies path-traversal variants", () => {
      expect(rejectedStatus("GET", "/swarm/./inspect")).toBe(403);
      expect(rejectedStatus("GET", "/foo/../swarm/init")).toBe(403);
      expect(rejectedStatus("GET", "//swarm/init")).toBe(403);
      expect(rejectedStatus("GET", "/containers/../swarm")).toBe(403);
    });

    it("denies backslash variants (windows-style separators)", () => {
      expect(rejectedStatus("GET", "\\swarm\\init")).toBe(403);
    });
  });

  describe("malformed targets", () => {
    it.each([
      ["a malformed percent-encoding", "/containers/%zz/json"],
      ["a control character", "/containers/a\u0001/json"],
      ["a non-ASCII character", "/containers/é/json"],
      ["a fragment", "/containers/abc/json#x"],
    ])("rejects %s with 400", (_label, path) => {
      expect(rejectedStatus("GET", path)).toBe(400);
    });
  });

  describe("API version floor", () => {
    it.each([
      ["POST", "/v1.43/containers/create"],
      ["POST", "/v1.4/containers/create"],
      ["POST", "/v1/containers/create"],
      ["POST", "/v1.43.9/containers/create"],
      ["POST", "/v0.99/containers/abc/exec"],
      ["POST", "/v1.99999999999999999999/containers/create"],
      ["GET", "/v1.24/containers/json"],
      ["POST", "/v1.24/containers/abc/start"],
      ["POST", "/v1.24/exec/abc/start"],
      ["GET", "/v1.43/_ping"],
      ["GET", "/v1.43/images/json"],
    ])("denies %s %s", (method, path) => {
      expect(rejectedStatus(method, path)).toBe(403);
    });

    it.each([
      ["/containers/create", ""],
      ["/v1.44/containers/create", "/v1.44"],
      ["/v1.52/containers/create", "/v1.52"],
      ["/v1.999/containers/create", "/v1.999"],
      ["/v2/containers/create", "/v2"],
      ["/v1.44//containers/./create", "/v1.44"],
    ])("keeps the version prefix of POST %s as %j", (path, versionPrefix) => {
      const r = classify("POST", path);
      assertKind(r, "create");
      expect(r.versionPrefix).toBe(versionPrefix);
    });
  });

  describe("container routes", () => {
    it.each([
      ["GET", "/containers/abc/json", "/json", "any"],
      ["GET", "/containers/abc/top", "/top", "any"],
      ["GET", "/containers/abc/stats", "/stats", "any"],
      ["GET", "/containers/abc/changes", "/changes", "any"],
      ["GET", "/containers/abc/export", "/export", "any"],
      ["GET", "/containers/abc/archive", "/archive", "any"],
      ["HEAD", "/containers/abc/archive", "/archive", "any"],
      ["POST", "/containers/abc/wait", "/wait", "any"],
      ["POST", "/containers/abc/resize", "/resize", "any"],
      ["PUT", "/containers/abc/archive", "/archive", "child"],
      ["POST", "/containers/abc/pause", "/pause", "child"],
      ["POST", "/containers/abc/unpause", "/unpause", "child"],
      ["POST", "/containers/abc/rename", "/rename", "child"],
    ])("%s %s checks ownership with depth %s", (method, path, suffix, depth) => {
      const r = classify(method, path);
      assertKind(r, "request");
      expect(r.route).toEqual({
        kind: "container",
        target: {
          ref: "abc",
          versionPrefix: "",
          suffix,
          depth,
          route: `${method} /containers/{id}${suffix}`,
        },
      });
    });

    it.each([
      ["/stop", ["t", "signal"]],
      ["/kill", ["signal"]],
    ])("POST /containers/abc%s is a child_signal, of a child only, keeping %j", (suffix, keys) => {
      const r = classify("POST", `/containers/abc${suffix}`);
      assertKind(r, "request");
      expect(r.route).toEqual({
        kind: "child_signal",
        target: {
          ref: "abc",
          versionPrefix: "",
          suffix,
          depth: "child",
          route: `POST /containers/{id}${suffix}`,
        },
        keys: new Set(keys),
      });
    });

    it.each([
      ["POST", "/containers/abc/start", "child_start", "/start"],
      ["POST", "/containers/abc/restart", "child_restart", "/restart"],
      ["DELETE", "/containers/abc", "child_remove", ""],
    ])("%s %s is a %s, of a child only", (method, path, kind, suffix) => {
      const r = classify(method, path);
      assertKind(r, "request");
      expect(r.route).toEqual({
        kind,
        target: {
          ref: "abc",
          versionPrefix: "",
          suffix,
          depth: "child",
          route: `${method} /containers/{id}${suffix}`,
        },
      });
    });

    it("forwards GET /containers/{id}/logs as a request, its response streaming", () => {
      const r = classify("GET", "/containers/abc/logs?follow=1&stdout=1");
      assertKind(r, "request");
      expect(r.route).toMatchObject({ kind: "container", target: { ref: "abc", suffix: "/logs" } });
    });

    it("reads a ref that spans segments, as the daemon's {name:.*} does", () => {
      const r = classify("GET", "/v1.44/containers/parent/alias/json?size=1");
      assertKind(r, "request");
      expect(r.route).toMatchObject({
        kind: "container",
        target: { ref: "parent/alias", versionPrefix: "/v1.44", suffix: "/json" },
      });
      expect(r.query.toString()).toBe("size=1");
    });

    it.each([
      ["/containers/abc/exec", "abc"],
      ["/v1.44/containers/abc/exec", "abc"],
      ["/containers/abc%2Fexec", "abc"],
      ["/containers/parent/alias/exec", "parent/alias"],
    ])("POST %s is an exec create on %s", (path, ref) => {
      const r = classify("POST", path);
      assertKind(r, "request");
      expect(r.route).toMatchObject({ kind: "exec_create", ref });
    });

    it("GET /containers/json is the container list", () => {
      const r = classify("GET", "/containers/json?all=1");
      assertKind(r, "request");
      expect(r.route).toEqual({ kind: "container_list", path: "/containers/json" });
    });
  });

  describe("stream routes", () => {
    it.each([
      ["POST", "/exec/abc/start"],
      ["POST", "/v1.44/exec/abc/start"],
      ["POST", "/containers/abc/attach"],
      ["GET", "/containers/abc/attach/ws"],
    ])("may upgrade %s %s", (method, path) => {
      expect(classify(method, path).kind).toBe("stream");
    });

    it("reads an exec id that spans segments", () => {
      const r = classify("POST", "/exec/a/b/start");
      assertKind(r, "stream");
      expect(r.route).toEqual({
        kind: "exec",
        target: { id: "a/b", versionPrefix: "", suffix: "/start" },
      });
    });
  });

  describe("plain routes", () => {
    it.each([
      ["GET", "/_ping", "/_ping"],
      ["HEAD", "/_ping", "/_ping"],
      ["GET", "/version", "/version"],
      ["GET", "/info", "/info"],
      ["GET", "/images/json", "/images/json"],
      ["GET", "/images/alpine:3/json", "/images/alpine:3/json"],
      ["GET", "/images/a%3Fb/history", "/images/a%3Fb/history"],
      ["GET", "/distribution/alpine/json", "/distribution/alpine/json"],
      ["GET", "/networks", "/networks"],
      ["GET", "/networks/", "/networks"],
      ["GET", "/networks/abc", "/networks/abc"],
      ["POST", "/networks/create", "/networks/create"],
      ["DELETE", "/networks/abc", "/networks/abc"],
      ["GET", "/volumes", "/volumes"],
      ["GET", "/volumes/v1", "/volumes/v1"],
      ["POST", "/volumes/create", "/volumes/create"],
    ])("forwards %s %s under %s", (method, path, forwarded) => {
      const r = classify(method, path);
      assertKind(r, "request");
      expect(r.route).toEqual({ kind: "plain", path: forwarded });
    });

    it("POST /images/create goes to its query policy", () => {
      const r = classify("POST", "/v1.44/images/create?fromImage=alpine");
      assertKind(r, "request");
      expect(r.route).toEqual({ kind: "image_create", versionPrefix: "/v1.44" });
    });

    it("GET /events is the filtered event stream", () => {
      const r = classify("GET", "/v1.44/events?since=0");
      assertKind(r, "request");
      expect(r.route).toEqual({ kind: "events", path: "/v1.44/events" });
    });

    it.each([
      ["connect", "/networks/bridge/connect"],
      ["disconnect", "/networks/bridge/disconnect"],
    ])("POST /networks/{id}/%s is a network endpoint", (op, path) => {
      const r = classify("POST", path);
      assertKind(r, "request");
      expect(r.route).toEqual({
        kind: "network_endpoint",
        network: "bridge",
        op,
        versionPrefix: "",
      });
    });
  });
});
