Biome warnings now fail `pnpm lint` and the pre-commit hook via
`--error-on-warnings`. Existing warnings cleared in the same pass:
`CodingProgressSubscriber` collapsed from a static-only class to a
plain `startCodingProgressSubscriber` function (Biome
`noStaticOnlyClass`); the OpenRouter `cache_control` extension on the
system message in `openai-compat.ts` is now expressed via a typed
intersection (`OpenAI.ChatCompletionContentPartText & { cache_control }`)
instead of an `as any` cast (`noExplicitAny`); a dead `makeSkillRow`
test factory and its now-unused `SkillRow` import are removed from
`transport-skills.test.ts` (`noUnusedVariables`).

The pre-commit hook keeps its `--staged` scope — it still only lints
files in the commit, not the whole repo — but the severity gate now
matches CI so warnings can't slip past locally and then break the push.
`biome.json`'s `$schema` URL is bumped 2.4.11 → 2.4.15 to match the
already-installed CLI.
