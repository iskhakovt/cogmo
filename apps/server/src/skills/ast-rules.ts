import { match } from "ts-pattern";
import { hostAllowed } from "./http-destination.js";
import type { SkillEffect } from "./types.js";

/**
 * Pure data backing {@link classifyWithAst} and the register-time gates
 * (`skill-gates.ts`). Two tables — imports we recognise as side-effecting
 * and call sites we recognise as side-effecting — are walked per skill. A
 * rule of an existing shape is one row; a new shape is a change to the
 * walker. A change to any row or gate bumps `AST_CLASSIFIER_VERSION`.
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

interface CallRuleBase {
  attr: string;
  effect: SkillEffect;
  label: string;
}

/** A call on a module, or on any receiver. */
interface ModuleCallRule extends CallRuleBase {
  /**
   * Dotted prefix on the receiver. `subprocess.run(...)` matches
   * `{object: "subprocess", attr: "run"}`. `null` matches a bare
   * function call (`open(...)`, `__import__(...)`).
   */
  object: string | null;
  /**
   * Optional positional-arg predicate. `OPEN_WRITE_MODE` only fires if
   * the call has a string-literal second arg whose value contains a
   * write-mode character (`w`, `a`, `x`, or `+`). Without it,
   * `open("file")` (read-only default) would false-positive.
   */
  argPredicate?: "open_write_mode";
}

/**
 * A ctx row: matches only `<receiver>.<namespace>.<attr>(...)` on a ctx
 * receiver (`python-ast.ts` → `ctxCalls`).
 */
interface CtxCallRule extends CallRuleBase {
  namespace: string;
}

export type CallRule = ModuleCallRule | CtxCallRule;

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
  // `smtplib` actually sends. `email` (stdlib) is intentionally absent
  // because it only constructs MIME messages — a skill that builds an
  // email and hands it to a webhook doesn't need to declare
  // `sends_email`. The smtplib rule carries the "this thing actually
  // talks SMTP" semantics.
  { module: "smtplib", effect: "sends_email", label: "smtplib" },
  { module: "slack_sdk", effect: "sends_message", label: "slack_sdk" },
  { module: "slackclient", effect: "sends_message", label: "slackclient" },
  { module: "discord", effect: "sends_message", label: "discord" },
  // Cogmo's primary channel is Telegram, so this rule trips every
  // skill that legitimately uses `python-telegram-bot`. That's the
  // right default — operators just declare `sends_message` in the
  // manifest and the deploy proceeds.
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
  // ctx rows: the effect `ctx-handler` requires of each method, which it
  // refuses at run time (`missing_effect`) when the manifest lacks it.
  {
    namespace: "memory",
    attr: "recall",
    effect: "reads_memory",
    label: "ctx.memory.recall",
  },
  {
    namespace: "memory",
    attr: "remember",
    effect: "writes_memory",
    label: "ctx.memory.remember",
  },
  {
    namespace: "files",
    attr: "read",
    effect: "reads_filesystem",
    label: "ctx.files.read",
  },
  {
    namespace: "files",
    attr: "list",
    effect: "reads_filesystem",
    label: "ctx.files.list",
  },
  {
    namespace: "files",
    attr: "write",
    effect: "writes_filesystem",
    label: "ctx.files.write",
  },
];

/**
 * Effects whose detection-without-declaration rejects the deploy
 * outright (writes a `validation_errors` entry, classifier returns
 * `risk_tier: "approve"` regardless). This is the "you forgot to
 * declare what you do" UX gate. The memory and filesystem reads are here
 * because `ctx-handler` refuses those calls without them; `reads_user_data`
 * and `writes_user_data` are advisory — they bump the tier, they don't reject.
 */
export const REJECT_ON_UNDECLARED: ReadonlySet<SkillEffect> = new Set<SkillEffect>([
  "reads_memory",
  "writes_memory",
  "reads_filesystem",
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

/**
 * The effects a write request falls under (design/skills.md → Register-time
 * gates → ctx rows): a skill declaring none of them has each write request
 * detected as `writes_user_data`.
 */
export const WRITE_EFFECTS: ReadonlySet<SkillEffect> = new Set<SkillEffect>([
  "writes_user_data",
  "sends_email",
  "sends_message",
  "posts_public",
  "deletes_external",
  "financial",
]);

/**
 * A request's path: the literal path it sends, or `templated` when an f-string
 * replacement field falls in it, read from the template before any URL
 * normalization, since a field can hold `/`, `..`, `?` or `#`.
 */
export type RequestPath = { kind: "literal"; path: string } | { kind: "templated" };

/** A host whose API acts on `GET`, and the paths that do. */
interface WriteEndpoint {
  host: string;
  /** Literal text and `*`, a `*` matching any text within one segment; compared without case. */
  paths: readonly string[];
}

/** The APIs that act on `GET` (design/skills.md → Write requests). */
const WRITE_ENDPOINTS: readonly WriteEndpoint[] = [
  // The Telegram Bot API, `/bot<token>/<method>`, whose method names are
  // case-insensitive.
  { host: "api.telegram.org", paths: ["/bot*/send*", "/bot*/edit*", "/bot*/delete*"] },
];

/**
 * Whether a request is a write: a method other than `GET`; a `GET` to a host
 * with `WRITE_ENDPOINTS` entries whose path is templated, since a field can
 * form any of them; or a `GET` whose literal path, percent-decoded, matches
 * one. `method` is uppercased, as `cogmo_ctx` sends it.
 */
export function isWriteRequest(method: string, host: string, path: RequestPath): boolean {
  if (method !== "GET") return true;
  const endpoints = WRITE_ENDPOINTS.filter((endpoint) => endpoint.host === host.toLowerCase());
  return match(path)
    .with({ kind: "templated" }, () => endpoints.length > 0)
    .with({ kind: "literal" }, ({ path: sent }) => {
      const decoded = decodeAsciiEscapes(sent);
      return endpoints.some((endpoint) =>
        endpoint.paths.some((pattern) => globRegExp(pattern).test(decoded)),
      );
    })
    .exhaustive();
}

/**
 * A path with each percent-encoded ASCII character decoded, as the API reads
 * it: `/bot1/%73endMessage` is `/bot1/sendMessage`. The patterns are ASCII, so
 * an escape of any other byte matches as it stands.
 */
function decodeAsciiEscapes(path: string): string {
  return path.replace(/%([0-7][0-9A-Fa-f])/g, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Whether `network.allow` admits a `WRITE_ENDPOINTS` host, for a request whose host is not literal. */
export function admitsWriteEndpoint(allow: ReadonlyArray<string>): boolean {
  return WRITE_ENDPOINTS.some((endpoint) => hostAllowed(endpoint.host, allow));
}

/** A `WRITE_ENDPOINTS` path pattern as a whole-path, case-insensitive match, `*` within one segment. */
function globRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "i");
}

/**
 * The Entrypoint gate's rule as an author reads it, in the toolchain's
 * `CLAUDE.md` and the authoring prompts (design/skills.md → Register-time
 * gates → Entrypoint).
 */
export const ENTRYPOINT_RULE =
  "`run` bound once, as one undecorated `async def run` directly at module level, taking exactly two parameters, none `*args`, `**kwargs` or keyword-only. With an `Input` or `Output` class, annotate `inputs: Input` and `-> Output` by their bare names.";

/** The entrypoint's signature with pydantic models, `Ctx` from `cogmo_ctx`, which the Entrypoint gate accepts. */
export const ENTRYPOINT_SIGNATURE = "async def run(inputs: Input, ctx: Ctx) -> Output";

/** `skill.py`'s bounds (design/skills.md → Register-time gates → Size). */
export const SKILL_BODY_MAX_LINES = 400;
/** 400 lines at the toolchain's 120-column `line-length`. */
export const SKILL_BODY_MAX_CHARACTERS = 48_000;

/** The names that build code at run time, refused by the `dynamic_code` gate. */
export const DYNAMIC_CODE_NAMES: ReadonlySet<string> = new Set([
  "exec",
  "eval",
  "compile",
  "__import__",
]);

/** The modules whose attributes are the builtins `DYNAMIC_CODE_NAMES` names. */
export const BUILTINS_MODULES: ReadonlySet<string> = new Set(["builtins", "__builtins__"]);

/** `importlib`'s attributes that import a module by a name built at run time. */
export const DYNAMIC_IMPORT_NAMES: ReadonlySet<string> = new Set(["import_module", "__import__"]);

/** A declared secret count at or above this threshold forces `approve`. */
export const APPROVE_SECRETS_THRESHOLD = 3;

/** Deps that don't bump risk tier — pure HTTP / data / template libs. See `design/skills.md`. */
export const DEPENDENCY_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "anyio",
  "beautifulsoup4",
  "certifi",
  "charset-normalizer",
  "dateparser",
  "h11",
  "httpcore",
  "httpx",
  "idna",
  "jinja2",
  "lxml",
  "markdown-it-py",
  "markupsafe",
  "orjson",
  "pendulum",
  "pydantic",
  "pydantic-core",
  "python-dateutil",
  "pytz",
  "pyyaml",
  "requests",
  "rich",
  "sniffio",
  "soupsieve",
  "tenacity",
  "typing-extensions",
  "urllib3",
]);

/** Deps that force `approve` — destructive surfaces, RCE, credentials. See `design/skills.md`. */
export const DEPENDENCY_APPROVE_LIST: ReadonlySet<string> = new Set<string>([
  // Cloud SDKs — broad surface, IAM-shaped credentials
  "boto3",
  "botocore",
  "google-cloud-storage",
  "google-cloud-firestore",
  "google-cloud-bigquery",
  "azure-storage-blob",
  // Payment / financial
  "stripe",
  "plaid-python",
  "braintree",
  // Mail
  "sendgrid",
  "mailgun",
  // Messaging vendors with destructive surface
  "twilio",
  // Database drivers — surface area for arbitrary mutation
  "psycopg",
  "psycopg2",
  "psycopg2-binary",
  "pymongo",
  "mysql-connector-python",
  "redis",
  // Remote execution / shell
  "paramiko",
  "fabric",
  // OAuth-bearing wrappers
  "requests-oauthlib",
  "google-auth",
  "google-auth-oauthlib",
  // Google APIs SDK — the import skills use to issue Drive/Calendar/etc.
  // writes; design doc's canonical OAuth example.
  "google-api-python-client",
  "googleapis-common-protos",
  // Cluster / container control — arbitrary external mutation.
  "kubernetes",
  "docker",
  // Telegram / Slack senders (mirrors the import rules)
  "python-telegram-bot",
  "slack-sdk",
  "slackclient",
  "discord-py",
]);

/** [PEP 503](https://peps.python.org/pep-0503/) name canonicalisation: lowercase + collapse `[-_.]` runs. */
export function normaliseDepName(dep: string): string {
  const idx = dep.indexOf("==");
  const name = idx === -1 ? dep : dep.slice(0, idx);
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
}

export type DependencyCategory = "allowlist" | "notify" | "approve";

export function categoriseDependency(dep: string): DependencyCategory {
  const name = normaliseDepName(dep);
  if (DEPENDENCY_APPROVE_LIST.has(name)) return "approve";
  if (DEPENDENCY_ALLOWLIST.has(name)) return "allowlist";
  return "notify";
}
