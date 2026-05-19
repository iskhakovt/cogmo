# Changelog

Per-PR changelog fragments. One Markdown file per PR — no shared file, no merge conflicts on parallel PRs.

**Filename:** `YYYY-MM-DD-short-slug.md`. The slug should be specific enough to disambiguate from other PRs the same day — base it on the change, not generic words. Listing this directory by name reads chronologically by date (slug-alphabetical within a day, which is close enough for an engineering log); `ls -r` reads newest-first.

**Body:** plain Markdown — the rich prose entry. No leading date, no table syntax. Rationale, side-effects, test counts, deferred follow-ups all welcome.

**Present tense, no migration recap.** Same rule as code comments (see [`.claude/rules/code-style.md`](../.claude/rules/code-style.md)): describe what the change IS, not the path that led there. Don't write "PR #N's refactor lifted X out of Y so this fixes Z", "the incident motivated this", or "previously the mock returned Y regardless". Conventional commits + PR descriptions own that history.

**Don't edit existing fragments.** Each PR appends one new fragment.

User-facing release notes are generated separately by `semantic-release` from Conventional Commit messages on push to `main` — see [../CONTRIBUTING.md](../CONTRIBUTING.md).
