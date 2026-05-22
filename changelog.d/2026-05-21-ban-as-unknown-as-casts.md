A GritQL plugin (`biome-plugins/no-unsafe-cast.grit`, registered in
`biome.json`) now flags `as unknown as T` in production TypeScript via
`pnpm lint`. The double cast is TypeScript's "type system blind spot" —
it silences the compiler without runtime safety. Preferred replacements
are `in` / `typeof` narrowing, a Zod parse at the boundary, or a
narrowing helper at the source. The plugin uses GritQL's `$filename`
builtin to skip `*.test.ts` and `src/test/**`; stubbing partial
interfaces is the dominant test use and `mock<T>()` / `mockDeep<T>()`
from `vitest-mock-extended` is the preferred replacement there (per
`.claude/rules/testing.md`).

Five of the eight production `as unknown as` casts are removed in the
same change:

- `src/llm/fallback.ts` and `src/llm/openai-compat.ts` narrow SDK error
  `status` / `code` fields with the `in` operator instead of casting
  `err` to `{ status?: unknown }`. Since TS 4.9, `"status" in err`
  narrows `unknown` to `err & { status: unknown }`, which is exactly
  what the runtime `typeof` guards below already assume.
- `OpenAICompatibleProvider.countTokens` narrows `tool_calls` via the
  union's `role === "assistant"` discriminator instead of casting `msg`
  to `Record<string, unknown>`. The same change drops two single-step
  `as` casts that were unsafe-narrowing `msg.content` and `msg.role`.
- `src/llm/json-schema.ts` introduces `toObjectJsonSchema(schema)`, a
  thin wrapper around `z.toJSONSchema` that throws if the result's
  `type` isn't `"object"` and returns the narrowed `JsonSchema`. Called
  from `src/agent/tools.ts` and `src/llm/typed.ts` (both previously
  open-coded the double cast).
- `transport.mcp.addServer` now takes a new `McpServerSpecInput` shape
  with `config: unknown`, reflecting that the value arrives from
  `JSON.parse` and gets validated by `McpServerConfigSchema` inside the
  transport boundary. The Telegram `/mcp add` handler passes the
  unknown straight through; the internal `McpRegistry.addServer` and
  `McpStore.addServer` keep the validated `McpServerSpec` shape.

Three production casts remain and carry inline `// biome-ignore` lines
naming the upstream type gap: dockerode's hijacked exec stream typed as
`Duplex` but used as `Writable` (`src/sandbox/supervisor.ts`); the AI
SDK's `generateImage` declaring `prompt: string` while the fal provider
accepts `{ text, images }` at runtime (`src/agent/image-tools.ts`); and
Inngest's `step.run<T>` returning `Promise<Jsonify<T>>` vs the simpler
test-facing `ObserverStepHarness` contract (`src/agent/evolution/observer.ts`).
