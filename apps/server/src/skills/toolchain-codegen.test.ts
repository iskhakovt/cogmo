import { readFileSync } from "node:fs";
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
  it("reads the image's uv and Python minor", () => {
    const root = repoRoot();
    const bake = readFileSync(join(root, "docker-bake.hcl"), "utf8");
    const python = readFileSync(join(root, "images/skills/.python-version"), "utf8").trim();
    const pins = readToolchainPins(root);

    expect(bake).toContain(`variable "UV_VERSION" {\n  default = "${pins.uvVersion}"`);
    expect(pins.pythonMinor).toBe(python);
  });
});

describe("renderToolchainPyproject", () => {
  const rendered = renderToolchainPyproject({ uvVersion: "9.8.7", pythonMinor: "3.99" });

  it("opens with a plain generated header", () => {
    expect(rendered.startsWith("# Generated; do not edit.\n")).toBe(true);
  });

  it("pins uv, the Python minor and the runtime's pydantic from its sources", () => {
    expect(rendered).toContain('required-version = "==9.8.7"');
    expect(rendered).toContain('requires-python = "==3.99.*"');
    expect(rendered).toContain('python-version = "3.99"');
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

  it("sends the author to no check a session cannot run yet", () => {
    expect(rendered).not.toContain(".cogmo/verify");
    expect(rendered).not.toContain("COGMO_VERIFY_BASE");
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
