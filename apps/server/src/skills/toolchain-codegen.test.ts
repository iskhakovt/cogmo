import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../test/repo-root.js";
import { RUNTIME_PACKAGES } from "./runtime-packages.js";
import {
  GENERATED_TOOLCHAIN_FILES,
  readToolchainPins,
  renderSkillManifestSchema,
  renderToolchainClaudeMd,
  renderToolchainPaths,
  renderToolchainPyproject,
} from "./toolchain-codegen.js";
import { SKILL_EFFECTS, SkillManifestSchema } from "./types.js";

describe("the generated skills repo toolchain", () => {
  it.each([
    [
      GENERATED_TOOLCHAIN_FILES.pyproject,
      () => renderToolchainPyproject(readToolchainPins(repoRoot())),
    ],
    [GENERATED_TOOLCHAIN_FILES.claudeMd, renderToolchainClaudeMd],
    [GENERATED_TOOLCHAIN_FILES.manifestSchema, renderSkillManifestSchema],
    [GENERATED_TOOLCHAIN_FILES.paths, renderToolchainPaths],
  ])(
    "%s matches its sources; run `pnpm --filter cogmo codegen:toolchain` when it does not",
    (path, render) => {
      expect(readFileSync(join(repoRoot(), path), "utf8")).toBe(render());
    },
  );

  it("lists the five root entries", () => {
    expect(renderToolchainPaths()).toBe("pyproject.toml\nuv.lock\nCLAUDE.md\n.gitignore\n.cogmo\n");
  });
});

describe("readToolchainPins", () => {
  it("reads the image's uv, Python minor and exact Python version", () => {
    const root = repoRoot();
    const bake = readFileSync(join(root, "docker-bake.hcl"), "utf8");
    const python = readFileSync(join(root, "images/skills/.python-version"), "utf8").trim();
    const dockerfile = readFileSync(join(root, "images/skills/Dockerfile"), "utf8");
    const pins = readToolchainPins(root);

    expect(bake).toContain(`variable "UV_VERSION" {\n  default = "${pins.uvVersion}"`);
    expect(pins.pythonMinor).toBe(python);
    expect(pins.pythonVersion).toMatch(new RegExp(`^${python.replace(".", "\\.")}\\.\\d+$`));
    const finalFrom = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("FROM "))
      .at(-1);
    expect(finalFrom).toContain(`python:${pins.pythonVersion}-slim`);
  });

  /** A repo root holding only what `readToolchainPins` reads, with `finalFrom` last. */
  function fakeRoot(finalFrom: string): string {
    const root = mkdtempSync(join(tmpdir(), "toolchain-pins-"));
    mkdirSync(join(root, "images/skills"), { recursive: true });
    writeFileSync(
      join(root, "docker-bake.hcl"),
      'variable "UV_VERSION" {\n  default = "9.8.7"\n}\n',
    );
    writeFileSync(join(root, "images/skills/.python-version"), "3.99\n");
    writeFileSync(
      join(root, "images/skills/Dockerfile"),
      `FROM mirror.gcr.io/library/python:3.99.1-slim AS builder\nRUN true\n${finalFrom}\n`,
    );
    return root;
  }

  it("takes the exact version from the Dockerfile's final FROM", () => {
    const root = fakeRoot("FROM mirror.gcr.io/library/python:3.99.7-slim@sha256:abc");
    try {
      expect(readToolchainPins(root)).toEqual({
        uvVersion: "9.8.7",
        pythonMinor: "3.99",
        pythonVersion: "3.99.7",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails naming the Dockerfile when its final FROM is not a python:<X.Y.Z>-slim image", () => {
    const root = fakeRoot("FROM builder AS runtime");
    try {
      expect(() => readToolchainPins(root)).toThrow(
        "images/skills/Dockerfile's final FROM names no python:<X.Y.Z>-slim image: FROM builder AS runtime",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the Dockerfile's Python is not on .python-version's minor", () => {
    const root = fakeRoot("FROM mirror.gcr.io/library/python:3.98.2-slim");
    try {
      expect(() => readToolchainPins(root)).toThrow(
        "images/skills/Dockerfile's final FROM runs Python 3.98.2, not on .python-version's 3.99",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderToolchainPyproject", () => {
  const rendered = renderToolchainPyproject({
    uvVersion: "9.8.7",
    pythonMinor: "3.99",
    pythonVersion: "3.99.7",
  });

  it("opens with a plain generated header", () => {
    expect(rendered.startsWith("# Generated; do not edit.\n")).toBe(true);
  });

  it("pins uv, the Python minor and exact version, and the runtime's pydantic from its sources", () => {
    expect(rendered).toContain('required-version = "==9.8.7"');
    expect(rendered).toContain('requires-python = "==3.99.*"');
    expect(rendered).toContain('python-version = "3.99.7"\n');
    expect(rendered).toContain(`"pydantic==${RUNTIME_PACKAGES.pydantic}",`);
  });

  it("makes a plain compile write register's bytes, and puts .cogmo on the tools' search paths", () => {
    expect(rendered).toContain("[tool.uv.pip]\npython-version");
    expect(rendered).toContain("generate-hashes = true\nno-header = true");
    expect(rendered).toContain("package = false");
    expect(rendered).toContain('select = ["E", "F", "B", "BLE", "S", "ASYNC"]');
    expect(rendered).toContain('[tool.pyrefly]\nsearch-path = [".cogmo"]');
    expect(rendered).toContain('pythonpath = [".cogmo"]\nasyncio_mode = "auto"');
  });
});

describe("renderToolchainClaudeMd", () => {
  const rendered = renderToolchainClaudeMd();

  it("opens with a plain generated header", () => {
    expect(rendered.startsWith("<!-- Generated; do not edit. -->\n")).toBe(true);
  });

  it("names the check that must pass, and the base it reads", () => {
    expect(rendered).toContain(
      "## Checks\n\n`uv run --locked --group dev .cogmo/verify` runs ruff, pyrefly and pytest over each skill changed since `COGMO_VERIFY_BASE`, the commit the branch was cut from. It must pass before the work is done.\n",
    );
  });

  it("names every frontmatter field and every effect", () => {
    for (const field of Object.keys(SkillManifestSchema.in.shape)) {
      expect(rendered).toContain(`- \`${field}\``);
    }
    for (const effect of SKILL_EFFECTS) expect(rendered).toContain(`- \`${effect}\``);
  });

  it("marks the fields an author must write", () => {
    expect(rendered).toContain("- `name` (required)");
    expect(rendered).toContain("- `tier` (required): one of `wasm`, `container`.");
    expect(rendered).toContain("- `effects`: a list of effects; default `[]`.");
  });

  it("states SkillError, the idempotency key, the read-only entries and no uv add or uv lock", () => {
    expect(rendered).toContain("`SkillError(kind, message)`");
    expect(rendered).toContain('`ctx.run()["key"]` as its `Idempotency-Key` header');
    expect(rendered).toContain(
      "Cogmo owns `pyproject.toml`, `uv.lock`, `CLAUDE.md`, `.gitignore` and `.cogmo/`",
    );
    expect(rendered).toContain("Do not run `uv add` or `uv lock`");
  });
});

describe("renderSkillManifestSchema", () => {
  it("is the JSON Schema of what an author writes", () => {
    const document: unknown = JSON.parse(renderSkillManifestSchema());

    expect(document).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "SKILL.md frontmatter",
      type: "object",
      required: ["name", "description", "tier"],
      properties: { effects: { items: { enum: [...SKILL_EFFECTS] } } },
    });
  });
});
