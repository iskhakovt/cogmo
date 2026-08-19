import { lookup } from "node:dns/promises";
import { z } from "zod";
import type { Service } from "../agent/service.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { CtxError, type CtxHandler } from "./dispatcher.js";
import type { SkillManifest } from "./types.js";
import { DEFAULT_WALL_CLOCK_S } from "./worker-wasm/host.js";

const log = logger.child({ component: "skills.ctx" });

/**
 * Tier-1 `ctx.*` v1 surface. Six methods cover the slice's end-to-end test
 * matrix; `attachments`, `llm.complete`, `notify` deferred to P3.2 (each
 * crosses module boundaries the slice does not otherwise touch — see plan).
 */
export const CTX_METHODS = [
  "secrets.get",
  "memory.recall",
  "memory.remember",
  "files.read",
  "files.write",
  "files.list",
  "now",
  "user",
  "log.info",
  "http.request",
] as const;
export type CtxMethod = (typeof CTX_METHODS)[number];

export interface CtxUser {
  id: string;
  timezone: string;
}

export interface DefaultCtxHandlerOptions {
  manifest: SkillManifest;
  /** `skill_runs.id` — every persisted ctx_call is scoped to this row. */
  runId: string;
  user: CtxUser;
  /** Memory bank id — typically the user's bank. */
  memoryBankId: string;
  secretsStore: SecretsStore;
  runInTx: Transactor;
  memory: MemoryProvider;
  /**
   * The agent's per-user file workspace. Same surface the in-process
   * `read_file` / `write_file` / `list_files` tools use — one workspace,
   * two callers. Skills only see paths their own host service exposes.
   */
  files: Service["files"];
  /**
   * Persists the call to `skill_context_calls` (target name only — never
   * value). Injected as a function so the handler doesn't require the full
   * `SkillStore`; the runner binds this to `SkillStore.recordContextCall`.
   */
  recordContextCall: (call: {
    runId: string;
    method: CtxMethod;
    target: string | null;
    ok: boolean;
    error: string | null;
  }) => Promise<void>;
  /** Pluggable clock for deterministic tests. Returns ISO-8601 UTC timestamp. */
  now?: () => string;
  /**
   * Resolves a hostname for the `http.request` destination check.
   * Injected so tests can pin an address without a real DNS round-trip,
   * the same reason `now` is pluggable.
   */
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

/**
 * Caps on a single `http.request`. The response is decoded into the WASM
 * heap, so an unbounded read is an OOM the skill cannot catch; the byte
 * cap is enforced while streaming rather than after, so an oversized body
 * is abandoned mid-flight instead of buffered first. The timeout is
 * independent of the skill's own `wall_clock_s` — that one kills the whole
 * task, where a hung request should fail as a catchable error and leave
 * the skill free to continue.
 */
const MAX_HTTP_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const MAX_HTTP_TIMEOUT_MS = 120_000;
/**
 * Headroom between a request timing out and the worker being terminated.
 * The wall clock kills the task outright, so a request allowed to run
 * right up to it never surfaces as the catchable `timeout` error this
 * method promises — the skill just disappears mid-call.
 */
const HTTP_TIMEOUT_WALL_CLOCK_MARGIN_MS = 5_000;

const SecretsGetArgsSchema = z.object({ name: z.string().min(1) });
const MemoryRecallArgsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
});
const MemoryRememberArgsSchema = z.object({
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
});
const FilesReadArgsSchema = z.object({ path: z.string().min(1) });
const FilesWriteArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
const FilesListArgsSchema = z.object({
  prefix: z.string().optional(),
});
const LogInfoArgsSchema = z.object({
  message: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
const HttpRequestArgsSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(MAX_HTTP_TIMEOUT_MS).optional(),
});

/**
 * Addresses a skill must not reach. `fetch` runs in the Cogmo server
 * process, so `ctx.http` carries the host's network position — which
 * includes every internal service the deployment can see. Hindsight sits
 * on `HINDSIGHT_URL` (`http://hindsight:8888` in the shipped compose) and
 * takes no auth, so an unchecked request reads or writes any memory bank,
 * around both the `memoryBankId` scoping and the `reads_memory` /
 * `writes_memory` gates this handler enforces for `ctx.memory`. Inngest,
 * the web UI and cloud metadata at 169.254.169.254 are the same shape of
 * target.
 *
 * This is the one place tier 1 is not at parity with tier 2: a tier-2
 * skill has real sockets but runs in a remote Daytona sandbox with no
 * route to the host's network, so without this check tier 1 would reach
 * strictly more than the less-isolated tier.
 *
 * Checked against resolved addresses rather than the literal, because the
 * interesting targets are names — `hindsight`, `localhost` — not dotted
 * quads. A name that resolves to anything private is refused.
 *
 * The check is not atomic with the connection: `fetch` resolves the name
 * again, so a server answering public first and private second defeats
 * this. Closing that needs a dispatcher that resolves, checks and
 * connects as one step; tracked in todo.md, since it turns on adding
 * undici as a runtime dependency.
 */
function parseIpv6(input: string): Uint8Array | null {
  let addr = input.split("%")[0] ?? ""; // drop any zone id
  // A trailing dotted quad (::ffff:127.0.0.1) is two hex groups wearing
  // another notation; fold it in so the rest of the parse is uniform.
  const embedded = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const octets = (embedded[2] ?? "").split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const lo = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    addr = `${embedded[1]}${hi}:${lo}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter((g) => g !== "") : [];
  const right =
    halves.length === 2 && halves[1] ? halves[1].split(":").filter((g) => g !== "") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? "";
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function isBlockedV4(a: number, b: number): boolean {
  if (a === 0 || a === 127) return true; // this-host, loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 192 && b === 88) return true; // 192.88.99.0/24 6to4 relay anycast
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const bytes = parseIpv6(address);
    // Unparseable is refused rather than allowed: an address shape this
    // does not understand is not one it can vouch for.
    if (!bytes) return true;
    // v4-mapped (::ffff:7f00:1 and ::ffff:127.0.0.1 are the same address
    // in different notations) is a v4 address, so judge it as one.
    const mapped =
      bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) return isBlockedV4(bytes[12] ?? 0, bytes[13] ?? 0);
    // Other ways an IPv4 address arrives wearing a v6 shape. NAT64 is the
    // live one: a DNS64 resolver synthesises an AAAA under 64:ff9b::/96
    // from a private A record, so the guard would wave through an address
    // the gateway then translates straight back to 10.x.
    const nat64 =
      bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      bytes.slice(4, 12).every((b) => b === 0);
    if (nat64) return isBlockedV4(bytes[12] ?? 0, bytes[13] ?? 0);
    // 2002::/16 6to4 carries the v4 address in the next four bytes.
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
      return isBlockedV4(bytes[2] ?? 0, bytes[3] ?? 0);
    }
    // ::a.b.c.d (IPv4-compatible, deprecated but still parsed).
    if (bytes.slice(0, 12).every((b) => b === 0) && !(bytes[12] === 0 && bytes[13] === 0)) {
      return isBlockedV4(bytes[12] ?? 0, bytes[13] ?? 0);
    }
    // fec0::/10 site-local, deprecated but still routed by some stacks.
    if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0xc0) return true;
    // ::1 loopback and :: unspecified, in any notation that expands to them.
    if (bytes.slice(0, 15).every((b) => b === 0) && (bytes[15] === 1 || bytes[15] === 0)) {
      return true;
    }
    if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true; // fe80::/10
    return false;
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  return isBlockedV4(parts[0] ?? 0, parts[1] ?? 0);
}

/**
 * Bound a promise that has no abort signal of its own. `dns.lookup` takes
 * no `AbortSignal`, so without this a resolver that never answers holds
 * the call open regardless of what the caller asked for. The underlying
 * work is not cancelled — nothing here can cancel it — but the skill
 * stops waiting on it.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`timed out after ${ms}ms ${what}`);
          e.name = "TimeoutError";
          reject(e);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read a response body, refusing anything past `cap`. Counting while
 * streaming means an oversized body is abandoned as soon as it crosses
 * the line, rather than buffered in full and measured afterwards — which
 * is the whole point of a cap when the consumer is a WASM heap.
 */
async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new CtxError("response_too_large", `http.request response exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Resolves `ctx.*` RPCs from a Tier 1 worker against host services. Every
 * invocation: (1) validates the args against a per-method schema, (2)
 * enforces manifest-declared allowlists, (3) hits the host service, (4)
 * persists to `skill_context_calls` (target name only — never value), (5)
 * returns the value or throws a typed `CtxError` the dispatcher will surface
 * as a typed Python exception.
 */
export class DefaultCtxHandler implements CtxHandler {
  #manifest: SkillManifest;
  #runId: string;
  #user: CtxUser;
  #memoryBankId: string;
  #secretsStore: SecretsStore;
  #runInTx: Transactor;
  #memory: MemoryProvider;
  #files: Service["files"];
  #recordContextCall: DefaultCtxHandlerOptions["recordContextCall"];
  #now: () => string;
  #resolveHost: NonNullable<DefaultCtxHandlerOptions["resolveHost"]>;
  #declaredSecrets: ReadonlySet<string>;

  constructor(opts: DefaultCtxHandlerOptions) {
    this.#manifest = opts.manifest;
    this.#runId = opts.runId;
    this.#user = opts.user;
    this.#memoryBankId = opts.memoryBankId;
    this.#secretsStore = opts.secretsStore;
    this.#runInTx = opts.runInTx;
    this.#memory = opts.memory;
    this.#files = opts.files;
    this.#recordContextCall = opts.recordContextCall;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#resolveHost = opts.resolveHost ?? ((hostname) => lookup(hostname, { all: true }));
    this.#declaredSecrets = new Set(
      opts.manifest.secrets.map((s) => (typeof s === "string" ? s : s.name)),
    );
  }

  async handle(call: { method: string; args: unknown }): Promise<unknown> {
    const method = call.method;
    if (!isCtxMethod(method)) {
      await this.#audit(method, null, false, "unknown_method");
      throw new CtxError("unknown_method", `unknown ctx method: ${method}`);
    }
    const value = await this.#dispatch(method, call.args);
    return value;
  }

  async #dispatch(method: CtxMethod, args: unknown): Promise<unknown> {
    switch (method) {
      case "secrets.get":
        return this.#secretsGet(args);
      case "memory.recall":
        return this.#memoryRecall(args);
      case "memory.remember":
        return this.#memoryRemember(args);
      case "files.read":
        return this.#filesRead(args);
      case "files.write":
        return this.#filesWrite(args);
      case "files.list":
        return this.#filesList(args);
      case "now":
        return this.#nowMethod();
      case "user":
        return this.#userMethod();
      case "log.info":
        return this.#logInfo(args);
      case "http.request":
        return this.#httpRequest(args);
    }
  }

  async #secretsGet(args: unknown): Promise<string> {
    const parsed = SecretsGetArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("secrets.get", null, false, "invalid_args");
      throw new CtxError("invalid_args", "secrets.get expects { name: string }");
    }
    const name = parsed.data.name;
    if (!this.#declaredSecrets.has(name)) {
      await this.#audit("secrets.get", name, false, "not_in_allowlist");
      throw new CtxError(
        "not_in_allowlist",
        `secret '${name}' is not declared in SKILL.md frontmatter`,
      );
    }
    const value = await this.#runInTx((tx) => this.#secretsStore.getSecret(tx, name));
    if (value === undefined) {
      await this.#audit("secrets.get", name, false, "secret_not_found");
      throw new CtxError("secret_not_found", `secret '${name}' is declared but not configured`);
    }
    await this.#audit("secrets.get", name, true, null);
    return value;
  }

  async #memoryRecall(args: unknown): Promise<{ memories: { content: string; type: string }[] }> {
    const parsed = MemoryRecallArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("memory.recall", null, false, "invalid_args");
      throw new CtxError("invalid_args", "memory.recall expects { query: string, limit?: number }");
    }
    if (!this.#manifest.effects.includes("reads_memory")) {
      await this.#audit("memory.recall", null, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "memory.recall requires effects: [reads_memory] in SKILL.md",
      );
    }
    const result = await this.#memory.recall(this.#memoryBankId, parsed.data.query, {});
    // Hindsight's RecallOptions takes `maxTokens`, not a per-item count.
    // The Python-facing `limit` is "max number of memories" — apply it
    // client-side after the recall returns. This also caps payload size
    // when the backend returns more than the skill asked for.
    const limit = parsed.data.limit;
    const sliced = limit === undefined ? result.memories : result.memories.slice(0, limit);
    await this.#audit("memory.recall", null, true, null);
    return {
      memories: sliced.map((m) => ({ content: m.content, type: m.type })),
    };
  }

  async #memoryRemember(args: unknown): Promise<null> {
    const parsed = MemoryRememberArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("memory.remember", null, false, "invalid_args");
      throw new CtxError(
        "invalid_args",
        "memory.remember expects { content: string, tags?: string[] }",
      );
    }
    if (!this.#manifest.effects.includes("writes_memory")) {
      await this.#audit("memory.remember", null, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "memory.remember requires effects: [writes_memory] in SKILL.md",
      );
    }
    await this.#memory.retain(this.#memoryBankId, parsed.data.content, {
      ...(parsed.data.tags && { tags: parsed.data.tags }),
    });
    await this.#audit("memory.remember", null, true, null);
    return null;
  }

  async #filesRead(args: unknown): Promise<string> {
    const parsed = FilesReadArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("files.read", null, false, "invalid_args");
      throw new CtxError("invalid_args", "files.read expects { path: string }");
    }
    if (!this.#manifest.effects.includes("reads_filesystem")) {
      await this.#audit("files.read", parsed.data.path, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "files.read requires effects: [reads_filesystem] in SKILL.md",
      );
    }
    try {
      const content = await this.#files.read(parsed.data.path);
      await this.#audit("files.read", parsed.data.path, true, null);
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#audit("files.read", parsed.data.path, false, "read_failed");
      throw new CtxError("read_failed", message);
    }
  }

  async #filesWrite(args: unknown): Promise<null> {
    const parsed = FilesWriteArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("files.write", null, false, "invalid_args");
      throw new CtxError("invalid_args", "files.write expects { path: string, content: string }");
    }
    if (!this.#manifest.effects.includes("writes_filesystem")) {
      await this.#audit("files.write", parsed.data.path, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "files.write requires effects: [writes_filesystem] in SKILL.md",
      );
    }
    try {
      await this.#files.write(parsed.data.path, parsed.data.content);
      await this.#audit("files.write", parsed.data.path, true, null);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#audit("files.write", parsed.data.path, false, "write_failed");
      throw new CtxError("write_failed", message);
    }
  }

  async #filesList(args: unknown): Promise<{
    entries: { path: string; size: number; last_modified: string }[];
  }> {
    const parsed = FilesListArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("files.list", null, false, "invalid_args");
      throw new CtxError("invalid_args", "files.list expects { prefix?: string }");
    }
    if (!this.#manifest.effects.includes("reads_filesystem")) {
      await this.#audit("files.list", parsed.data.prefix ?? null, false, "missing_effect");
      throw new CtxError(
        "missing_effect",
        "files.list requires effects: [reads_filesystem] in SKILL.md",
      );
    }
    try {
      const entries = await this.#files.list(parsed.data.prefix);
      await this.#audit("files.list", parsed.data.prefix ?? null, true, null);
      return {
        entries: entries.map((e) => ({
          path: e.path,
          size: e.size,
          last_modified: e.lastModified.toISOString(),
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#audit("files.list", parsed.data.prefix ?? null, false, "list_failed");
      throw new CtxError("list_failed", message);
    }
  }

  async #nowMethod(): Promise<string> {
    const value = this.#now();
    await this.#audit("now", null, true, null);
    return value;
  }

  async #userMethod(): Promise<CtxUser> {
    await this.#audit("user", null, true, null);
    return this.#user;
  }

  /**
   * Request timeout, held under the skill's own wall clock so a hung
   * request fails as an error the skill can catch rather than as a
   * terminated worker. A caller asking for longer than the task will
   * live gets the shorter of the two.
   */
  #httpTimeoutMs(requested: number | undefined): number {
    const wallClockMs = (this.#manifest.resources?.wall_clock_s ?? DEFAULT_WALL_CLOCK_S) * 1000;
    // Sized against the whole budget rather than what is left of it. The
    // accurate elapsed figure needs the moment the task reached a runtime,
    // and the only timestamps available here precede a tier-2 pool
    // acquisition that can itself consume most of the budget — counting
    // from one of those makes every request on a cold pool believe it has
    // nothing left. Erring long instead means a request begun late can be
    // killed with the worker rather than returning a timeout, which is
    // what any long operation does today; erring short would break the
    // common case outright. Tracked in todo.md.
    const ceiling = Math.max(1, wallClockMs - HTTP_TIMEOUT_WALL_CLOCK_MARGIN_MS);
    return Math.min(requested ?? DEFAULT_HTTP_TIMEOUT_MS, ceiling);
  }

  /**
   * Outbound HTTP on behalf of a tier-1 skill.
   *
   * Pyodide has no sockets, so `urllib` / `http.client` cannot work inside
   * the WASM sandbox at all. Routing through the host is what gives tier 1
   * a network path, and it puts every request at a point the skill cannot
   * reach around: the URL is audited here, and any future egress policy
   * has one place to sit. Tier-2 skills talk to the network directly with
   * real sockets, so nothing here is a permission boundary today — it is
   * the mechanism that makes one possible.
   */
  async #httpRequest(args: unknown): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const parsed = HttpRequestArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("http.request", null, false, "invalid_args");
      throw new CtxError(
        "invalid_args",
        "http.request expects { method, url, headers?, body?, timeoutMs? }",
      );
    }
    const { method, url, headers, body, timeoutMs } = parsed.data;

    // `z.string().url()` accepts any parseable URL, including `file:` and
    // `data:`, which would turn a network call into a host-filesystem read.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      await this.#audit("http.request", null, false, "invalid_args");
      throw new CtxError("invalid_args", `http.request could not parse url: ${url}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      await this.#audit("http.request", parsedUrl.protocol, false, "invalid_args");
      throw new CtxError(
        "invalid_args",
        `http.request supports http and https, got '${parsedUrl.protocol}'`,
      );
    }
    // Query strings routinely carry API keys, so the audit records origin
    // and path only — enough to see where a skill reached, without
    // persisting the credential that got it there.
    const target = `${parsedUrl.origin}${parsedUrl.pathname}`;
    // One budget spans resolution and the request. Starting the clock at
    // the fetch would let a slow resolver add unbounded time in front of
    // it, so a caller asking for 5s could wait far longer.
    const timeoutBudgetMs = this.#httpTimeoutMs(timeoutMs);
    const budgetStartedMs = Date.now();

    try {
      // `URL.hostname` keeps the brackets on an IPv6 literal; no resolver
      // takes those. The original `url` still goes to `fetch` untouched.
      const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "");
      const resolved = await withDeadline(
        this.#resolveHost(hostname),
        timeoutBudgetMs,
        `resolving ${hostname}`,
      );
      const blocked = resolved.find((r) => isBlockedAddress(r.address, r.family));
      if (blocked) {
        await this.#audit("http.request", target, false, "blocked_destination");
        throw new CtxError(
          "blocked_destination",
          `http.request refused ${target}: ${parsedUrl.hostname} resolves to ${blocked.address}, ` +
            `which is on the host's own network rather than the public internet`,
        );
      }
    } catch (e) {
      if (e instanceof CtxError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      // A resolver deadline is a timeout like any other — classifying it
      // as a transport failure would tell a caller not to retry something
      // that is worth retrying.
      const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error";
      await this.#audit("http.request", target, false, kind);
      throw new CtxError(kind, `http.request could not resolve ${target}: ${message}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        ...(headers && { headers }),
        ...(body !== undefined && { body }),
        // Not followed: a redirect is a second destination, and following
        // it here would skip the resolve check above — the standard way
        // around an SSRF guard. The 3xx and its `location` come back to
        // the skill, which reaches the next hop with another call that
        // gets checked like any other.
        redirect: "manual",
        // What survived resolution. Reusing the whole budget here would
        // let a call asking for 10s run for nearly 20.
        signal: AbortSignal.timeout(Math.max(1, timeoutBudgetMs - (Date.now() - budgetStartedMs))),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error";
      await this.#audit("http.request", target, false, kind);
      throw new CtxError(kind, `http.request to ${target} failed: ${message}`);
    }

    let text: string;
    try {
      text = await readCapped(response, MAX_HTTP_RESPONSE_BYTES);
    } catch (e) {
      if (e instanceof CtxError) {
        await this.#audit("http.request", target, false, e.kind);
        throw e;
      }
      // The same signal covers the body, so a stall here aborts too —
      // and reads as a timeout rather than a generic transport failure.
      const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error";
      const message = e instanceof Error ? e.message : String(e);
      await this.#audit("http.request", target, false, kind);
      throw new CtxError(kind, `http.request to ${target} failed mid-body: ${message}`);
    }

    // A 4xx/5xx is a response the skill should get to inspect, not an
    // exception — the status is right there in the return value. Only a
    // failure to *obtain* a response throws.
    await this.#audit("http.request", target, true, null);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: text,
    };
  }

  async #logInfo(args: unknown): Promise<null> {
    const parsed = LogInfoArgsSchema.safeParse(args);
    if (!parsed.success) {
      await this.#audit("log.info", null, false, "invalid_args");
      throw new CtxError(
        "invalid_args",
        "log.info expects { message: string, fields?: Record<string, unknown> }",
      );
    }
    log.info(
      {
        // Skill-supplied fields go FIRST so the trusted host fields below
        // can't be spoofed (object-spread later wins). A skill calling
        // `ctx.log.info("hi", skillRunId="evil")` will have its `skillRunId`
        // overwritten by the real one.
        ...parsed.data.fields,
        skillRunId: this.#runId,
        skillName: this.#manifest.name,
      },
      parsed.data.message,
    );
    await this.#audit("log.info", null, true, null);
    return null;
  }

  /**
   * Audit failures are logged (warn) but do NOT propagate. Trade-off: a DB
   * hiccup shouldn't break skill execution mid-flight, but the consequence
   * is that a successful `secrets.get` can return the secret value to
   * Python without a corresponding audit row landing in `skill_context_calls`.
   *
   * TODO(P3.3): when the design's threat model gets a formal review,
   * decide whether audit-failure should be fail-closed (refuse to return
   * the value) for sensitive methods like `secrets.get` while staying
   * fail-open for low-risk methods like `now()`.
   */
  async #audit(
    method: CtxMethod | string,
    target: string | null,
    ok: boolean,
    errorKind: string | null,
  ): Promise<void> {
    try {
      await this.#recordContextCall({
        runId: this.#runId,
        method: method as CtxMethod,
        target,
        ok,
        error: errorKind,
      });
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e), method },
        "failed to record ctx audit row",
      );
    }
  }
}

function isCtxMethod(method: string): method is CtxMethod {
  return (CTX_METHODS as readonly string[]).includes(method);
}
