# Installs a wasm skill's wheels. `pyodide-worker.ts` runs this file in the
# Pyodide globals at boot, mounts the skill's read-only wheel directory, then
# awaits `_install_wheels(mount, files)` before it signals ready; a failure
# here is the worker's `fatal`.
#
# The host resolved the lockfile and checked every wheel against its
# `requirements.lock` hash (`design/skills.md` → Wasm-tier boundary, layer 4), so
# micropip installs the files as they are, without resolving dependencies or
# reaching the network. The version check after the install catches a wheel
# whose metadata disagrees with its file name.
import importlib.metadata as _md

import micropip


async def _install_wheels(mount, files):
    await micropip.install([f"emfs:{mount}/{f}" for f in files], deps=False)
    mismatches = []
    for f in files:
        # A wheel's file name escapes `-` in its name and version, so the
        # first two fields are exactly those.
        name, version = f.split("-")[:2]
        try:
            installed = _md.version(name)
        except _md.PackageNotFoundError:
            mismatches.append(f"{name}: not installed")
            continue
        if installed != version:
            mismatches.append(f"{name}: wheel {version}, installed {installed}")
    if mismatches:
        raise RuntimeError("dep version verification failed: " + "; ".join(mismatches))
