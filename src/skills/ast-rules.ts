import type { SkillEffect } from "./types.js";

/**
 * Pure data backing {@link classifyWithAst}. Two tables — imports we
 * recognise as side-effecting and call sites we recognise as side-
 * effecting — are walked per skill. Adding a rule is "drop a row";
 * no code change in the classifier.
 *
 * Rule scope is intentionally narrow: this is a UX gate, not a
 * security boundary. A skill body can `getattr(__import__("os"),
 * "system")(...)` and bypass detection — sysbox + the `approve` tier
 * are the actual boundaries (see `ast-classifier.ts` head comment).
 */

export interface ImportRule {
  /**
   * Top-level module name we match. `import x.y.z` matches `x` (we
   * normalize to the leftmost identifier of the dotted name); `from
   * x.y import z` likewise — the package root is what tells us "this
   * skill talks to SMTP" or "this skill talks to Stripe."
   */
  module: string;
  effect: SkillEffect;
  /** Friendly label that appears in `validation_errors`. */
  label: string;
}

export interface CallRule {
  /**
   * Dotted prefix on the receiver. `subprocess.run(...)` matches
   * `{object: "subprocess", attr: "run"}`. `null` matches a bare
   * function call (`open(...)`, `__import__(...)`).
   */
  object: string | null;
  attr: string;
  effect: SkillEffect;
  label: string;
  /**
   * Optional positional-arg predicate. `OPEN_WRITE_MODE` only fires if
   * the call has a string-literal second arg whose value contains a
   * write-mode character (`w`, `a`, `x`, or `+`). Without it,
   * `open("file")` (read-only default) would false-positive.
   */
  argPredicate?: "open_write_mode";
}

/**
 * Top-level imports → effect. Matched against every `import` /
 * `from … import …` statement in the body, normalised to the leftmost
 * package segment.
 *
 * Curated to the set the manifest can declare; broader categories
 * (generic HTTP via `requests`/`httpx`, Anthropic SDK, etc.) are
 * intentionally absent because the manifest has no matching effect to
 * declare them under and forcing every skill to declare "uses
 * network" would defeat the auto-tier.
 */
export const IMPORT_RULES: readonly ImportRule[] = [
  { module: "smtplib", effect: "sends_email", label: "smtplib" },
  { module: "email", effect: "sends_email", label: "email (SMTP/SMTP-likely)" },
  { module: "slack_sdk", effect: "sends_message", label: "slack_sdk" },
  { module: "slackclient", effect: "sends_message", label: "slackclient" },
  { module: "discord", effect: "sends_message", label: "discord" },
  { module: "telegram", effect: "sends_message", label: "telegram" },
  { module: "twilio", effect: "sends_message", label: "twilio" },
  { module: "stripe", effect: "financial", label: "stripe" },
  { module: "plaid", effect: "financial", label: "plaid" },
  { module: "subprocess", effect: "spawns_subprocess", label: "subprocess" },
  { module: "multiprocessing", effect: "spawns_subprocess", label: "multiprocessing" },
];

/**
 * Call patterns → effect. One pattern per side-effecting stdlib /
 * library entry point. The `attr` is matched on a call's attribute
 * function part; `object` (when non-null) is matched on the receiver
 * one level out. Method calls on `pathlib.Path` instances are matched
 * with `object: null` because the receiver is an arbitrary path
 * variable (`p.unlink()`, `Path("x").write_text("y")`) — we accept
 * the false positives any same-named method on unrelated objects
 * would produce.
 */
export const CALL_RULES: readonly CallRule[] = [
  // subprocess module — function calls
  { object: "subprocess", attr: "run", effect: "spawns_subprocess", label: "subprocess.run" },
  { object: "subprocess", attr: "Popen", effect: "spawns_subprocess", label: "subprocess.Popen" },
  { object: "subprocess", attr: "call", effect: "spawns_subprocess", label: "subprocess.call" },
  {
    object: "subprocess",
    attr: "check_call",
    effect: "spawns_subprocess",
    label: "subprocess.check_call",
  },
  {
    object: "subprocess",
    attr: "check_output",
    effect: "spawns_subprocess",
    label: "subprocess.check_output",
  },
  // os module — process spawn
  { object: "os", attr: "system", effect: "spawns_subprocess", label: "os.system" },
  { object: "os", attr: "popen", effect: "spawns_subprocess", label: "os.popen" },
  { object: "os", attr: "execv", effect: "spawns_subprocess", label: "os.execv" },
  { object: "os", attr: "execvp", effect: "spawns_subprocess", label: "os.execvp" },
  { object: "os", attr: "execvpe", effect: "spawns_subprocess", label: "os.execvpe" },
  { object: "os", attr: "spawnv", effect: "spawns_subprocess", label: "os.spawnv" },
  { object: "os", attr: "spawnvp", effect: "spawns_subprocess", label: "os.spawnvp" },
  { object: "os", attr: "posix_spawn", effect: "spawns_subprocess", label: "os.posix_spawn" },
  { object: "os", attr: "fork", effect: "spawns_subprocess", label: "os.fork" },
  // os module — filesystem mutation
  { object: "os", attr: "remove", effect: "writes_filesystem", label: "os.remove" },
  { object: "os", attr: "unlink", effect: "writes_filesystem", label: "os.unlink" },
  { object: "os", attr: "rmdir", effect: "writes_filesystem", label: "os.rmdir" },
  { object: "os", attr: "removedirs", effect: "writes_filesystem", label: "os.removedirs" },
  { object: "os", attr: "rename", effect: "writes_filesystem", label: "os.rename" },
  { object: "os", attr: "replace", effect: "writes_filesystem", label: "os.replace" },
  { object: "os", attr: "mkdir", effect: "writes_filesystem", label: "os.mkdir" },
  { object: "os", attr: "makedirs", effect: "writes_filesystem", label: "os.makedirs" },
  { object: "os", attr: "chmod", effect: "writes_filesystem", label: "os.chmod" },
  { object: "os", attr: "chown", effect: "writes_filesystem", label: "os.chown" },
  { object: "os", attr: "truncate", effect: "writes_filesystem", label: "os.truncate" },
  { object: "os", attr: "symlink", effect: "writes_filesystem", label: "os.symlink" },
  { object: "os", attr: "link", effect: "writes_filesystem", label: "os.link" },
  // shutil module
  { object: "shutil", attr: "rmtree", effect: "writes_filesystem", label: "shutil.rmtree" },
  { object: "shutil", attr: "copy", effect: "writes_filesystem", label: "shutil.copy" },
  { object: "shutil", attr: "copy2", effect: "writes_filesystem", label: "shutil.copy2" },
  { object: "shutil", attr: "copyfile", effect: "writes_filesystem", label: "shutil.copyfile" },
  { object: "shutil", attr: "copytree", effect: "writes_filesystem", label: "shutil.copytree" },
  { object: "shutil", attr: "move", effect: "writes_filesystem", label: "shutil.move" },
  // pathlib.Path methods — matched without object qualification because the
  // receiver is an arbitrary path-typed variable. Accepts false positives any
  // same-named method on a non-Path object would produce; in practice
  // `.write_text` / `.unlink` / `.touch` on something other than a Path is
  // exotic enough that flagging it as filesystem-write is the right default.
  { object: null, attr: "write_text", effect: "writes_filesystem", label: ".write_text()" },
  { object: null, attr: "write_bytes", effect: "writes_filesystem", label: ".write_bytes()" },
  // multiprocessing
  {
    object: "multiprocessing",
    attr: "Process",
    effect: "spawns_subprocess",
    label: "multiprocessing.Process",
  },
  // open() — built-in. Predicate filters down to write-mode opens; default
  // mode is read-only and we don't want to false-positive every CSV reader.
  {
    object: null,
    attr: "open",
    effect: "writes_filesystem",
    label: "open(..., write_mode)",
    argPredicate: "open_write_mode",
  },
];

/**
 * Effects whose detection-without-declaration rejects the deploy
 * outright (writes a `validation_errors` entry, classifier returns
 * `risk_tier: "approve"` regardless). This is the "you forgot to
 * declare what you do" UX gate. Reads (memory / filesystem / user
 * data) are advisory — they bump the tier, they don't reject.
 */
export const REJECT_ON_UNDECLARED: ReadonlySet<SkillEffect> = new Set<SkillEffect>([
  "spawns_subprocess",
  "writes_filesystem",
  "deletes_external",
  "sends_email",
  "sends_message",
  "posts_public",
  "financial",
]);

/**
 * Effects that gate the `approve` tier. Mirrors the stub classifier's
 * gating set — see `classifier.ts` for the rationale: anything in this
 * set means a misbehaving skill could send messages, delete external
 * resources, move money, write to the host filesystem, or shell out.
 */
export const APPROVE_GATING_EFFECTS: ReadonlySet<SkillEffect> = new Set<SkillEffect>([
  "deletes_external",
  "sends_email",
  "sends_message",
  "posts_public",
  "financial",
  "spawns_subprocess",
  "writes_filesystem",
]);

/** A declared secret count at or above this threshold forces `approve`. */
export const APPROVE_SECRETS_THRESHOLD = 3;
