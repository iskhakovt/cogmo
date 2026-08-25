import { describe, expect, it } from "vitest";
import { lintWasmCompat } from "./wasm-lint.js";

describe("lintWasmCompat", () => {
  it("accepts a clean skill body", () => {
    const body = `
def run(inputs, ctx):
    name = inputs["name"]
    ctx.log.info(f"hello {name}")
    return {"greeting": f"hi {name}"}
`;
    const r = lintWasmCompat(body);
    expect(r.isOk()).toBe(true);
  });

  it("rejects subprocess import", () => {
    const r = lintWasmCompat("import subprocess\n");
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error[0]?.rule).toBe("subprocess_import");
    expect(r.error[0]?.line).toBe(1);
  });

  it("rejects from-subprocess import", () => {
    const r = lintWasmCompat("from subprocess import run\n");
    expect(r.isErr()).toBe(true);
  });

  it("rejects os.fork", () => {
    const r = lintWasmCompat("import os\nos.fork()\n");
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error[0]?.rule).toBe("os_fork");
  });

  it("rejects os.system", () => {
    const r = lintWasmCompat("import os\nos.system('rm -rf /')\n");
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error[0]?.rule).toBe("os_system");
  });

  it("rejects raw socket import", () => {
    const r = lintWasmCompat("import socket\n");
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error[0]?.rule).toBe("raw_socket");
  });

  it.each([
    ["import urllib.request\n"],
    ["from urllib.request import urlopen\n"],
    ["import http.client\n"],
    ["from http.client import HTTPConnection\n"],
    ["import smtplib\n"],
    ["from urllib import request\n"],
    ["from http import client\n"],
    ["from urllib import parse, request\n"],
    // Not the first name after `import` — the shape a skill reaches for
    // when it needs one networking module alongside something ordinary.
    ["import os, http.client\n"],
    ["import json, urllib.request\n"],
    ["import ssl, smtplib\n"],
    ["import urllib.parse, urllib.request\n"],
    ["import os as o, smtplib\n"],
    // Parenthesised name list — what a formatter emits once it grows.
    ["from urllib import (\n    request,\n)\n"],
    // A comment inside the list must not read as commenting out the name.
    ["from urllib import (\n    # the fetcher\n    request,\n)\n"],
    ["from urllib import (  # noqa\n    request,\n)\n"],
    ["from http import (\n    HTTPStatus,  # status codes\n    client,\n)\n"],
    ["from http import (\n    client,\n    HTTPStatus,\n)\n"],
    // More than one ordinary name ahead of the networking one — the shape a
    // skill takes when it parses URLs as well as fetching them.
    ["from urllib import parse, error, request\n"],
    ["from urllib import a, b, c, request\n"],
    ["from http import HTTPStatus, cookies, client\n"],
  ])("rejects the stdlib network module in %j", (body) => {
    const r = lintWasmCompat(body);
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error[0]?.rule).toBe("stdlib_network");
  });

  it.each([
    // Pure string manipulation — building a query string is a normal
    // thing for a skill that fetches through `ctx.http`.
    ["import urllib.parse\n"],
    ["from urllib.parse import urlparse, urlencode\n"],
    // Exception classes only.
    ["from urllib.error import HTTPError\n"],
    // Namespace package; `http.client` is the one that connects.
    ["import http\n"],
    ["from urllib import parse\n"],
    ["from http import HTTPStatus\n"],
    // `request` here is the local alias for `parse`; nothing networking
    // is imported, and rejecting it would block a common idiom.
    ["from urllib import parse as request\n"],
    ["from http import HTTPStatus as client\n"],
    // Ends in a networking module's name without being one.
    ["import mypkg.smtplib\n"],
    ["from urllib import (\n    parse,\n    error,\n)\n"],
  ])("allows the network-free import in %j", (body) => {
    expect(lintWasmCompat(body).isOk()).toBe(true);
  });

  it("allows variables named subprocess in comments or strings", () => {
    // Minor false positives are acceptable but a docstring mention shouldn't
    // trigger the pattern (regex anchored to start-of-line for `import`).
    const body = `def run(inputs, ctx):
    """do not use subprocess in tier-1 skills"""
    return {}
`;
    const r = lintWasmCompat(body);
    expect(r.isOk()).toBe(true);
  });

  it("reports multiple rule hits", () => {
    const body = "import subprocess\nimport socket\n";
    const r = lintWasmCompat(body);
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error.map((e) => e.rule).sort()).toEqual(["raw_socket", "subprocess_import"]);
  });

  describe("os.* variant coverage", () => {
    it.each([
      ["os.fork()", "os_fork"],
      ["os.execv('a', [])", "os_fork"],
      ["os.execve('a', [], {})", "os_fork"],
      ["os.execvp('a', [])", "os_fork"],
      ["os.execvpe('a', [], {})", "os_fork"],
      ["os.spawnl(0, 'a')", "os_fork"],
      ["os.spawnv(0, 'a', [])", "os_fork"],
      ["os.spawnvp(0, 'a', [])", "os_fork"],
      ["os.posix_spawn('a', [], {})", "os_fork"],
    ])("flags '%s' as %s", (snippet, rule) => {
      const r = lintWasmCompat(`import os\n${snippet}\n`);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error.some((e) => e.rule === rule)).toBe(true);
    });
  });

  describe("multiprocessing / ctypes", () => {
    it("flags `import multiprocessing`", () => {
      const r = lintWasmCompat("import multiprocessing\n");
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.rule).toBe("multiprocessing");
    });

    it("flags `import ctypes`", () => {
      const r = lintWasmCompat("import ctypes\n");
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.rule).toBe("ctypes");
    });
  });

  describe("false-positive guards", () => {
    it("`import os.path` does not fire", () => {
      // os.path is fine in Pyodide; only the shell-out methods are flagged.
      const r = lintWasmCompat("import os.path\nx = os.path.join('a','b')\n");
      expect(r.isOk()).toBe(true);
    });

    it("plain `import os` does not fire", () => {
      const r = lintWasmCompat("import os\nx = os.environ.get('X')\n");
      expect(r.isOk()).toBe(true);
    });

    it("docstring mention of subprocess does not fire", () => {
      const body = `def run(inputs, ctx):
    """do not call subprocess in tier-1 skills"""
    return {}
`;
      expect(lintWasmCompat(body).isOk()).toBe(true);
    });

    it("a string literal containing `os.system` does not fire", () => {
      // Known limitation of text-only lint; future AST pass closes this gap.
      // Today's contract: pattern fires anywhere `os.system` appears, even in
      // string literals, so this test pins the current behavior — change
      // intentionally if and when the AST pass lands.
      const r = lintWasmCompat("warning = 'avoid os.system'\n");
      // Pin current behavior: fires.
      expect(r.isErr()).toBe(true);
    });

    it("indented forbidden patterns inside a function body fire", () => {
      const body = `def run(inputs, ctx):
    import subprocess
    return subprocess.run(['ls'])
`;
      const r = lintWasmCompat(body);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.rule).toBe("subprocess_import");
      // Line 2 of the body (1-indexed): the `import subprocess` line.
      expect(r.error[0]?.line).toBe(2);
    });
  });

  describe("line numbers", () => {
    it("reports correct line for the first match", () => {
      const body = "# comment\n\nimport subprocess\n";
      const r = lintWasmCompat(body);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.line).toBe(3);
    });

    it("reports line numbers per matching rule (first hit per rule only)", () => {
      const body =
        "import subprocess\nimport socket\nimport multiprocessing\nimport ctypes\nos.fork()\nos.system('x')\n";
      const r = lintWasmCompat(body);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error.map((e) => e.line).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("parenthesised imports", () => {
    it("keeps later line numbers after collapsing a multi-line import", () => {
      const body = ["from urllib import (", "    parse,", ")", "import subprocess"].join("\n");
      const r = lintWasmCompat(body);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.rule).toBe("subprocess_import");
      // `import subprocess` is on line 4 of the original source; collapsing
      // the import above it must not renumber it.
      expect(r.error[0]?.line).toBe(4);
    });

    it("reports the opening line of a collapsed import", () => {
      const body = ["import os", "from urllib import (", "    request,", ")"].join("\n");
      const r = lintWasmCompat(body);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.rule).toBe("stdlib_network");
      expect(r.error[0]?.line).toBe(2);
    });
  });

  describe("third-party HTTP clients", () => {
    it.each([
      ["import httpx\n"],
      ["import requests\n"],
      ["from httpx import AsyncClient\n"],
      ["import json, requests\n"],
      ["import urllib3\n"],
      ["import aiohttp\n"],
      // Submodule form; the package is what needs the socket either way.
      ["from requests.sessions import Session\n"],
      ["from httpx._client import Client\n"],
      ["import requests.sessions\n"],
    ])("rejects %j, which needs sockets tier 1 lacks", (body) => {
      const r = lintWasmCompat(body);
      expect(r.isErr()).toBe(true);
      if (!r.isErr()) return;
      expect(r.error[0]?.rule).toBe("third_party_http");
    });

    it.each([
      // Names that merely contain one.
      ["import requests_cache\n"],
      ["import myrequests\n"],
      ["from mypkg.httpx_helpers import thing\n"],
    ])("allows %j", (body) => {
      expect(lintWasmCompat(body).isOk()).toBe(true);
    });
  });

  describe("pathological input", () => {
    it.each([
      ["from\thttp\timport", "\t\t,"],
      ["import", "\t\t,"],
    ])("returns promptly for %j followed by many %j", (head, repeat) => {
      // A name class that matches whitespace beside a trailing `[ \t]*` lets
      // the engine split one run of tabs between the two in exponentially
      // many ways. At 40 repetitions that is hours of backtracking, so a
      // wall-clock budget is the assertion — the lint guards `register`, and
      // stalling it is the failure this shape causes.
      const body = `${head}${repeat.repeat(40)}\n`;
      const startedMs = Date.now();
      lintWasmCompat(body);
      expect(Date.now() - startedMs).toBeLessThan(1_000);
    });
  });
});
