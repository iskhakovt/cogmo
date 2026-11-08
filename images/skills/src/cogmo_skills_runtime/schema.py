"""Register's container-tier schema import: `python3 -I -m cogmo_skills_runtime.schema [<lockfile hash>]`.

Reads `skill.py` from stdin, activates the skill venv for the lockfile hash when one is given, imports the body
and writes one `schema_import_reply` line to stdout: the models' JSON Schemas (`cogmo_ctx._run.contract_schemas`),
`schema_failed` when the skill did not load or a model could not be described, or `fatal` when the venv would not
activate. The host runs it in a session created with no network (design/skills.md → Contracts). What module code
writes to stdout, through Python or straight to fd 1, goes to stderr, so the reply is the only line on stdout.
"""

import contextlib
import json
import os
import sys
from typing import TextIO

from cogmo_ctx._run import contract_schemas
from cogmo_skills_runtime.supervisor import _activate_skill_venv


def _reply(stdout: TextIO, reply: dict[str, object]) -> None:
    stdout.write(json.dumps(reply) + "\n")
    stdout.flush()


def main(argv: list[str], stdin: TextIO, stdout: TextIO, stderr: TextIO) -> None:
    """Import the skill read from `stdin` and write its reply to `stdout`; `argv` holds the lockfile hash, if any."""
    body = stdin.read()
    if argv:
        try:
            _activate_skill_venv(argv[0])
        except RuntimeError as e:
            _reply(stdout, {"type": "fatal", "error": f"skill_venv: {e}"})
            return
    namespace: dict[str, object] = {}
    with contextlib.redirect_stdout(stderr):
        try:
            exec(compile(body, "<skill>", "exec"), namespace)
        # A module that calls `sys.exit` or raises `KeyboardInterrupt` did not load either.
        except BaseException as e:
            _reply(stdout, {"type": "schema_failed", "error": f"skill.py did not load: {type(e).__name__}: {e}"})
            return
        try:
            encoded = contract_schemas(namespace)
        except Exception as e:
            error = f"its models' JSON Schemas could not be written: {type(e).__name__}: {e}"
            _reply(stdout, {"type": "schema_failed", "error": error})
            return
    schemas = json.loads(encoded)
    _reply(stdout, {"type": "schemas", "inputs": schemas["inputs"], "outputs": schemas["outputs"]})


if __name__ == "__main__":
    # The reply goes out on a copy of stdout; fd 1 becomes stderr, so what module code or a native extension writes
    # there cannot split the reply's line.
    reply_fd = os.dup(1)
    os.dup2(2, 1)
    with os.fdopen(reply_fd, "w") as reply:
        main(sys.argv[1:], sys.stdin, reply, sys.stderr)
