# Changelog

| Date | Change |
|-|-|
| 2026-03-23 | End-to-end message pipeline — LLM abstraction (provider-agnostic), agentic loop, CLI adapter, Inngest orchestration with DI, 37 unit tests |
| 2026-03-23 | Initial Drizzle migration generated and verified against PostgreSQL |
| 2026-03-23 | CLAUDE.md — design philosophy (early abstractions, event decoupling, thin infra), testing rules, DI stance, code style |
| 2026-03-23 | Replace BullMQ with Inngest — event-driven durable execution, added to Docker Compose, updated all design docs |
| 2026-03-23 | Add todo.md + `/next` command — priority-based task tracking |
| 2026-03-23 | Add confidence markers to all design docs (`[confirmed]`/`[proposed]`/`[research]`) |
| 2026-03-23 | Remove nucleus/NixOS-specific details — app is now deployment-agnostic |
| 2026-03-23 | Rewrite data-model.md — Drizzle as source of truth, lean Phase 1 schema (3 tables), deferred tables documented for later |
| 2026-03-23 | Add Docker Compose (PostgreSQL + pgvector, Redis), Drizzle schema + config, db connection module |
| 2026-03-23 | Scaffold Phase 0 — package.json, tsconfig, tsup, Biome 2.x, Vitest, Pino logger, env parsing (@t3-oss/env-core + Zod v4), directory structure |
| 2026-03-22 | Add tooling.md — dev stack research (pnpm, tsx, tsup, Fastify, Drizzle, Vitest, Pino, Biome, Remeda, neverthrow) |
| 2026-03-22 | Add data-model.md (unified PostgreSQL schema), testing.md (local dev, mocking, evaluation) |
| 2026-03-22 | Add session lifecycle, context window mgmt, message batching, Telegram auth to agents.md |
| 2026-03-22 | Add Hindsight deployment clarification, `claude -p` integration pattern to architecture.md |
| 2026-03-22 | PROGRESS.md: add missing Phase 0/1/2 tasks (schema, session lifecycle, auth, `claude -p`) |
| 2026-03-22 | Fix design doc gaps: stateless-per-invocation model, GroupQueue priority, signal capture schema, embedding model, Stage 4 graduation features |
| 2026-03-22 | Add PROGRESS.md — phased delivery plan (Phase 0-5) |
| 2026-03-22 | Initial design docs — 9 files distilled from 22 research docs |
