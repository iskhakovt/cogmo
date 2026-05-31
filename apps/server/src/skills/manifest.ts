import { err, ok, type Result } from "neverthrow";
import { parse as parseYaml } from "yaml";
import { type SkillManifest, SkillManifestSchema } from "./types.js";

/**
 * Frontmatter delimiter — three dashes alone on a line. Matches the Anthropic
 * SKILL.md convention; lenient on trailing whitespace.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export interface ParsedManifest {
  manifest: SkillManifest;
  /** Markdown body with frontmatter stripped. May be empty. */
  body: string;
}

export type ManifestParseError =
  | { kind: "missing_frontmatter"; message: string }
  | { kind: "invalid_yaml"; message: string }
  | { kind: "invalid_manifest"; message: string; issues: readonly string[] };

/**
 * Parse a `SKILL.md` source: strip the YAML frontmatter, validate it against
 * `SkillManifestSchema`, return the validated manifest plus the markdown body
 * unchanged. Returns `Result` because user-authored YAML is failure-expected
 * — the register RPC surfaces the error to the author.
 */
export function parseManifest(source: string): Result<ParsedManifest, ManifestParseError> {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) {
    return err({
      kind: "missing_frontmatter",
      message: "SKILL.md must start with a YAML frontmatter block delimited by '---' lines",
    });
  }
  const [, yamlSource, body] = match;
  if (yamlSource === undefined || body === undefined) {
    return err({ kind: "missing_frontmatter", message: "frontmatter block is empty" });
  }

  let raw: unknown;
  try {
    raw = parseYaml(yamlSource);
  } catch (e) {
    return err({
      kind: "invalid_yaml",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const parsed = SkillManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    return err({
      kind: "invalid_manifest",
      message: "manifest failed schema validation",
      issues,
    });
  }

  return ok({ manifest: parsed.data, body });
}
