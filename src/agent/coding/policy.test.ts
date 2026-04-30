import { describe, expect, it } from "vitest";
import { evaluate } from "./policy.js";

function bash(command: string) {
  return evaluate({ tool: "Bash", input: { command } });
}

describe("policy.evaluate", () => {
  describe("non-Bash tools", () => {
    it("allows file ops without prompt", () => {
      for (const tool of ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit"]) {
        const r = evaluate({ tool, input: { path: "/etc/passwd" } });
        expect(r.decision).toBe("allow");
      }
    });

    it("allows agent tools (Task, TodoWrite, WebFetch, WebSearch)", () => {
      for (const tool of ["Task", "TodoWrite", "WebFetch", "WebSearch", "Skill"]) {
        const r = evaluate({ tool, input: {} });
        expect(r.decision).toBe("allow");
      }
    });

    it("allows MCP tools by default", () => {
      const r = evaluate({ tool: "mcp__github__create_pr", input: {} });
      expect(r.decision).toBe("allow");
    });
  });

  describe("Bash — read-only and local", () => {
    it.each([
      "ls",
      "ls -la",
      "cat README.md",
      "head -n 20 file.ts",
      "tail -f log.out",
      "pwd",
      "whoami",
      "find . -name '*.ts'",
      "rg foo",
      "git status",
      "git log --oneline -10",
      "git diff",
      "git branch -a",
      "tree src",
      "ps -ef",
      "env",
    ])("allows %s", (cmd) => {
      expect(bash(cmd).decision).toBe("allow");
    });
  });

  describe("Bash — test/build/lint/format/install", () => {
    it.each([
      "pnpm test",
      "pnpm typecheck",
      "pnpm lint",
      "pnpm exec biome check .",
      "pnpm install",
      "pnpm add zod",
      "npm ci",
      "yarn install",
      "vitest run",
      "tsc --noEmit",
      "cargo test",
      "cargo build",
      "cargo clippy",
      "cargo fmt",
      "pytest",
      "ruff check .",
      "mypy src",
      "go test ./...",
      "go build ./...",
      "pip install requests",
      "uv pip install pandas",
    ])("allows %s", (cmd) => {
      expect(bash(cmd).decision).toBe("allow");
    });
  });

  describe("Bash — local docker actions", () => {
    it.each([
      "docker ps",
      "docker images",
      "docker run --rm alpine echo hi",
      "docker build -t x .",
      "docker compose up -d",
      "docker exec foo pwd",
    ])("allows %s", (cmd) => {
      expect(bash(cmd).decision).toBe("allow");
    });
  });

  describe("Bash — in-container destructive ops are allowed", () => {
    it.each(["rm -rf node_modules", "rm /tmp/stuff", "rm -rf /etc"])("allows %s", (cmd) => {
      // The container is the boundary — rm inside is fine; the next task
      // gets a fresh worktree.
      expect(bash(cmd).decision).toBe("allow");
    });
  });

  describe("Bash — git push prompts", () => {
    it.each([
      "git push",
      "git push origin main",
      "git push origin cogmo/abc",
      "git push --force-with-lease origin main",
      "git -C /repo push",
      "git -C /repo -c user.email=x@y.com push origin main",
      "git --git-dir=/path/.git push",
      "git -c push.default=current push",
    ])("prompts on %s (handles git global flags before subcommand)", (cmd) => {
      const r = bash(cmd);
      expect(r.decision).toBe("prompt");
      expect(r.reason).toContain("git push");
    });
  });

  describe("Bash — gh mutations prompt", () => {
    it.each([
      ["gh pr create --draft", "pr create"],
      ["gh pr merge 123", "pr merge"],
      ["gh pr review 123 --approve", "pr review"],
      ["gh pr close 42", "pr close"],
      ["gh pr edit 1 --title foo", "pr edit"],
      ["gh issue create --title foo", "issue create"],
      ["gh issue close 1", "issue close"],
      ["gh release create v1.0.0", "release create"],
      ["gh repo delete foo/bar", "repo delete"],
    ])("prompts on `%s`", (cmd, hint) => {
      const r = bash(cmd);
      expect(r.decision).toBe("prompt");
      expect(r.reason.toLowerCase()).toContain(hint.split(" ")[0] as string);
    });

    it.each([
      "gh pr view 1",
      "gh pr list",
      "gh pr status",
      "gh issue list",
      "gh repo view",
    ])("allows read-only `%s`", (cmd) => {
      expect(bash(cmd).decision).toBe("allow");
    });
  });

  describe("Bash — package publishes prompt", () => {
    it.each([
      "npm publish",
      "pnpm publish",
      "yarn publish",
      "npm unpublish foo",
      "cargo publish",
      "cargo yank --version 1.0 foo",
      "uv publish",
      "twine upload dist/*",
    ])("prompts on %s", (cmd) => {
      expect(bash(cmd).decision).toBe("prompt");
    });
  });

  describe("Bash — HTTP write detection", () => {
    it("prompts on curl POST to an external URL", () => {
      const r = bash("curl -X POST https://example.com/api -d foo");
      expect(r.decision).toBe("prompt");
      expect(r.reason).toContain("example.com");
    });

    it("prompts on curl --request DELETE to external URL", () => {
      expect(bash("curl --request DELETE https://api.example.com/users/1").decision).toBe("prompt");
    });

    it("prompts on curl --request=PUT (= form)", () => {
      expect(bash("curl --request=PUT https://example.com/r -d a=b").decision).toBe("prompt");
    });

    it("allows curl GET", () => {
      expect(bash("curl https://example.com/api").decision).toBe("allow");
      expect(bash("curl -X GET https://example.com/api").decision).toBe("allow");
    });

    it.each([
      "curl -d 'a=b' https://example.com/r",
      "curl --data 'a=b' https://example.com/r",
      "curl --data=foo https://example.com/r",
      "curl --data-raw 'a=b' https://example.com/r",
      "curl --data-binary @file https://example.com/r",
      "curl --data-urlencode 'a=b' https://example.com/r",
      "curl -F 'file=@x' https://example.com/r",
      "curl --form 'file=@x' https://example.com/r",
      "curl -T file.tar.gz https://example.com/r",
      "curl --upload-file file.tar.gz https://example.com/r",
    ])("prompts on implicit-POST flag: %s", (cmd) => {
      expect(bash(cmd).decision).toBe("prompt");
    });

    it.each([
      "curl -dfoo https://example.com/r",
      "curl -F@file https://example.com/r",
      "curl -Tfile.tar.gz https://example.com/r",
    ])("prompts on short-attached implicit-POST: %s", (cmd) => {
      expect(bash(cmd).decision).toBe("prompt");
    });

    it.each([
      "curl -XPOST https://example.com/r",
      "curl -X POST https://example.com/r",
      "curl --request=DELETE https://example.com/r",
      "curl --request DELETE https://example.com/r",
    ])("prompts on explicit verb form: %s", (cmd) => {
      expect(bash(cmd).decision).toBe("prompt");
    });

    it("prompts when --request=<verb> is the trailing token", () => {
      // Flag at end of tokens — the loop bound mustn't exclude it.
      expect(bash("curl https://example.com/r --request=DELETE").decision).toBe("prompt");
    });

    it("treats curl -I / --head as HEAD (allow)", () => {
      expect(bash("curl -I https://example.com").decision).toBe("allow");
      expect(bash("curl --head https://example.com").decision).toBe("allow");
    });

    it("allows POST to localhost", () => {
      expect(bash("curl -X POST http://localhost:8080/echo -d foo").decision).toBe("allow");
      expect(bash("curl -X POST http://127.0.0.1/r -d foo").decision).toBe("allow");
      expect(bash("curl -X POST http://[::1]:9000/r").decision).toBe("allow");
    });

    it.each([
      "curl -X POST http://[::1]:8080/r -d foo",
      "curl --request=PUT http://[::1]/r",
      "curl -F 'file=@x' http://[::1]:3000/upload",
    ])("allows IPv6 bracketed localhost write: %s", (cmd) => {
      expect(bash(cmd).decision).toBe("allow");
    });

    it("allows POST to 0.0.0.0 (treated as local-bind)", () => {
      expect(bash("curl -X POST http://0.0.0.0:8080/r -d foo").decision).toBe("allow");
    });

    it("prompts on unbracketed IPv6 (URL parse fails, treated as non-local)", () => {
      // `http://::1/` is not a valid URL per Node's parser — IPv6 hosts
      // must be bracketed. The `try { new URL(...) } catch` branch in
      // isLocalhostUrl returns false, so this falls into the prompt path.
      expect(bash("curl 'http://::1/' -X POST -d foo").decision).toBe("prompt");
    });

    it("allows POST to *.localhost / *.local subdomains", () => {
      expect(bash("curl -X POST http://api.localhost/r -d foo").decision).toBe("allow");
      expect(bash("curl -X POST http://dev.local/r -d foo").decision).toBe("allow");
    });

    it("prompts on wget --post-data to external URL", () => {
      expect(bash("wget --post-data='a=b' https://example.com/r").decision).toBe("prompt");
    });

    it("allows wget --post-data to IPv6 bracketed localhost", () => {
      expect(bash("wget --post-data='a=b' http://[::1]:8080/r").decision).toBe("allow");
    });

    it("allows wget GET", () => {
      expect(bash("wget https://example.com/file.tar.gz").decision).toBe("allow");
    });

    it("prompts on quoted URL containing `&` query separator (single-`&` is not a compound op)", () => {
      // The shell-splitter only matches `&&` (compound), not bare `&`, so
      // a query string with `?q=foo&bar` stays atomic and the curl branch
      // sees the full URL — host resolves to api.github.com → external →
      // prompt. This pins behaviour for the comment in splitShellCommand
      // about quoted operators not being respected: `&` happens to be
      // safe by accident because `&&` is the matched token, not `&`.
      const r = bash('curl "http://api.github.com/repos?q=foo&bar" -X POST -d a=b');
      expect(r.decision).toBe("prompt");
      expect(r.reason).toContain("api.github.com");
    });
  });

  describe("Bash — compound commands", () => {
    it("prompts when any sub-command is a prompt-trigger", () => {
      const r = bash("pnpm test && git push origin main");
      expect(r.decision).toBe("prompt");
      expect(r.reason).toContain("git push");
    });

    it("allows when all sub-commands are allow", () => {
      expect(bash("pnpm test && pnpm lint && pnpm typecheck").decision).toBe("allow");
    });

    it("allows `&&` chain of read-only git commands", () => {
      expect(bash("git status && git diff").decision).toBe("allow");
    });

    it("prompts on `&&` chain when right side is npm publish", () => {
      const r = bash("npm install && npm publish");
      expect(r.decision).toBe("prompt");
      expect(r.reason).toContain("publish");
    });

    it("prompts on `||` chains too", () => {
      expect(bash("pnpm test || git push --force origin main").decision).toBe("prompt");
    });

    it("prompts on `;` separators", () => {
      expect(bash("pnpm test; git push").decision).toBe("prompt");
    });

    it("allows `;` chain when all sub-commands are allow", () => {
      expect(bash("pnpm test; pnpm lint").decision).toBe("allow");
    });

    it("prompts on pipes", () => {
      expect(bash("echo foo | curl -X POST https://example.com/r -d @-").decision).toBe("prompt");
    });

    it("prompts on pipe chain when downstream command is a prompt-trigger", () => {
      const r = bash("cat changelog.md | gh release create v1.0.0 --notes-file -");
      expect(r.decision).toBe("prompt");
      expect(r.reason.toLowerCase()).toContain("release");
    });

    it("returns the first prompt reason in a multi-prompt chain", () => {
      // Worst-case-wins: scanner walks left to right and the first prompt
      // result is locked in (`worst.decision === "allow"` guard skips
      // later prompts). Pinning the order so a future change to the
      // walker is a deliberate decision, not a silent shift.
      const r = bash("git push && npm publish");
      expect(r.decision).toBe("prompt");
      expect(r.reason).toContain("git push");
    });
  });

  describe("Bash — empty / weird input", () => {
    it("allows empty Bash command", () => {
      expect(evaluate({ tool: "Bash", input: { command: "" } }).decision).toBe("allow");
    });

    it("allows missing command field", () => {
      expect(evaluate({ tool: "Bash", input: {} }).decision).toBe("allow");
    });

    it("allows whitespace-only command", () => {
      expect(evaluate({ tool: "Bash", input: { command: "   \t\n" } }).decision).toBe("allow");
    });
  });
});
