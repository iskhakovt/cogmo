Read `todo.md`. Pick up to 10 tasks from "Next", highest priority first (`p1` > `p2` > `p3`).

Present them as a numbered list, each with:
- What the task is
- One line of context — why it matters or what it unblocks

Then ask me which one I want to work on (or if I want to see more options / do something else).

When a task is completed:
1. **Delete the entry** from `todo.md` (no Done graveyard — `changelog.d/` holds the durable record)
2. Update PROGRESS.md — check off the corresponding phase item if one exists
3. Drop a fragment in `changelog.d/` — file `YYYY-MM-DD-short-slug.md` (slug specific enough that two parallel same-day PRs won't collide), Markdown body, rich prose. Never edit existing fragments.
