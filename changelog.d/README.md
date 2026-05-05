# Changelog

Per-PR changelog fragments. One Markdown file per PR — no shared file, no merge conflicts on parallel PRs.

**Filename:** `YYYY-MM-DD-NN-short-slug.md` where `NN` is a two-digit sequence within the day (`01`, `02`, ...). Listing this directory by name reads chronologically; `ls -r` reads newest-first.

**Body:** plain Markdown — the rich prose entry. No leading date, no table syntax. Rationale, side-effects, test counts, deferred follow-ups all welcome.

**Don't edit existing fragments.** Each PR appends one new fragment.

User-facing release notes are generated separately by `semantic-release` from Conventional Commit messages on push to `main` — see [../CONTRIBUTING.md](../CONTRIBUTING.md).
