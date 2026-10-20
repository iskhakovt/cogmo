"""The runtime's Python ABI tag, `py<major>.<minor>`.

A skill venv on `/skill-venvs` is named `<lockfile hash>-<tag>`. The host's
populate and reap scripts (`apps/server/src/skills/deps.ts`,
`deps-reaper.ts`) read the tag from `python3 -m cogmo_skills_runtime.abi`,
and the supervisor builds the same name to activate a venv. An image whose
Python minor differs has a different tag, so it populates fresh venvs and
the reaper sweeps the old ones.
"""

import sys


def python_abi_tag() -> str:
    return f"py{sys.version_info.major}.{sys.version_info.minor}"


if __name__ == "__main__":
    print(python_abi_tag())
