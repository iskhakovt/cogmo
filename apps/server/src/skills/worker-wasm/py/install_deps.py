# Installs a tier-1 skill's dependencies. `worker-entry.ts` runs this file
# in the Pyodide globals at worker boot, then awaits
# `_install_and_verify(specs)` with the skill's `pkg==version` pins before
# it signals ready; a failure here is the worker's `fatal`.
#
# micropip has no `--require-hashes`: the WASM tier trusts PyPI's wire
# integrity (`design/skills.md` → Security posture). The version check
# after the install catches a pin the resolver skipped and a Pyodide-bundled
# version that differs from the pin.
import importlib.metadata as _md

import micropip


async def _install_and_verify(specs):
    await micropip.install(specs, keep_going=False)
    mismatches = []
    for spec in specs:
        name, _, version = spec.partition("==")
        if not version:
            continue
        try:
            installed = _md.version(name)
        except _md.PackageNotFoundError:
            mismatches.append(f"{name}: not installed")
            continue
        if installed != version:
            mismatches.append(f"{name}: requested {version}, installed {installed}")
    if mismatches:
        raise RuntimeError("dep version verification failed: " + "; ".join(mismatches))
