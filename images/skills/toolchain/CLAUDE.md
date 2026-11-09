<!-- Generated; do not edit. -->

# Cogmo skills

Cogmo's skill library. A branch deploys one skill: it changes that skill's files and nothing else.

## Layout

Each skill is a directory `skills/<name>/` holding only:

- `SKILL.md`: YAML frontmatter, then a body saying when to use the skill.
- `skill.py`: the entrypoint.
- `requirements.lock`: the lockfile, when the skill declares dependencies.
- `test_skill.py`: a pytest test for each example, and one for a failure.

Cogmo owns `pyproject.toml`, `uv.lock`, `CLAUDE.md`, `.gitignore` and `.cogmo/`, and replaces them on each release. They are read-only: a branch that changes one is refused.

## skill.py

```python
from pydantic import BaseModel

from cogmo_ctx import Ctx, SkillError


class Input(BaseModel):
    city: str


class Output(BaseModel):
    summary: str


async def run(inputs: Input, ctx: Ctx) -> Output: ...
```

- `Input` and `Output` are the skill's contract: register derives the tool's schemas from them.
- Raise `SkillError(kind, message)` for an expected failure, with `retryable=True` when a later attempt may succeed (an outage, a rate limit). Never catch an exception to return success: any other exception is a defect.
- Reach the outside only through `ctx`. A write request through `ctx.http` sends `ctx.run()["key"]` as its `Idempotency-Key` header, so a retry cannot act twice.

Register refuses a `skill.py` that breaks any of these:

- At most 1000 lines and 120000 characters.
- `run` bound once, as one undecorated `async def run` directly at module level, taking exactly two parameters, none `*args`, `**kwargs` or keyword-only. With an `Input` or `Output` class, annotate `inputs: Input` and `-> Output` by their bare names.
- No code built at run time: no `exec`, `eval`, `compile` or `__import__`, no `importlib.import_module`, and no `getattr` on an imported module by a computed name.
- Each `ctx.memory` and `ctx.files` call's effect declared. A literal URL's host is in `network.allow`, and a literal secret name in `secrets`.

## SKILL.md frontmatter

`.cogmo/skill.schema.json` is its JSON Schema.

- `name` (required): a string matching `^[a-z][a-z0-9_-]*$`, 1 to 64 characters. The skill's directory, `skills/<name>/`.
- `description` (required): a string, 10 to 500 characters. The model reads it to choose the skill.
- `tier` (required): one of `wasm`, `container`. `wasm` runs in Pyodide and installs only pure-Python wheels.
- `isolation`: one of `subinterpreter`, `recycle`. Container tier only.
- `triggers`: a list of `manual`, `cron`, `event`; default `["manual"]`.
- `schedule`: a string. A cron expression; required with the `cron` trigger.
- `inputs`: an object with `type`, `properties`, `required`. Only for a skill without an `Input` model, which is otherwise the one source.
- `outputs`: an object. Only for a skill without an `Output` model, which is otherwise the one source.
- `effects`: a list of effects; default `[]`. Every effect the code has, from the list below.
- `secrets`: a list; default `[]`. The names the code reads with `ctx.secrets.get`.
- `dependencies`: a list of strings matching `^[a-z0-9]([a-z0-9._-]*[a-z0-9])?==[a-zA-Z0-9.+!-]+$`; default `[]`. Direct dependencies, each pinned exactly.
- `network`: an object with `allow`. The hosts `ctx.http` may reach; none when absent.
- `resources`: an object with `memory_mb`, `wall_clock_s`, `cpu_shares`.
- `cost_per_call_usd`: a number, at least 0; default `0`.
- `budget`: an object with `daily_usd`, `monthly_usd`, `per_invocation_usd_cap`.

Effects:

- `reads_memory`
- `writes_memory`
- `reads_user_data`
- `writes_user_data`
- `sends_email`
- `sends_message`
- `posts_public`
- `deletes_external`
- `financial`
- `reads_filesystem`
- `writes_filesystem`
- `spawns_subprocess`

## Dependencies

List each direct dependency as `name==version` under `dependencies`, then write the lockfile from the repo root:

```sh
printf '%s\n' httpx==0.27.0 | uv pip compile - > skills/<name>/requirements.lock
```

`pyproject.toml` supplies `--generate-hashes`, `--no-header` and the image's Python version, so the output matches register's own compile byte for byte. Skills share the runtime's pydantic: when a dependency needs it, also declare `pydantic==2.12.5`. Do not run `uv add` or `uv lock`: the project's dependencies are Cogmo's tools, not the skill's.

## Checks

`uv run --locked --group dev .cogmo/verify` runs ruff, pyrefly and pytest over each skill changed since `COGMO_VERIFY_BASE`, the commit the branch was cut from. It must pass before the work is done.
