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
});
