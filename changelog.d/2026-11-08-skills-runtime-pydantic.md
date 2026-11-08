Both skill runtimes provide one pydantic, 2.12.5 with `pydantic-core` 2.41.5, the version Pyodide builds in (design/skills.md → Contracts).

- The `cogmo-skills` image's runtime venv depends on `pydantic==2.12.5`, so a container-tier skill imports it without declaring it. A wasm child loads Pyodide's pydantic when the skill imports `pydantic` or `pydantic_core`, filled into the package cache like any built-in.
- Register rejects, as `runtime_package_conflict`, a lockfile that pins `pydantic` or `pydantic-core` at another version, or `typing-extensions`, `annotated-types` or `typing-inspection` below the version pydantic requires; the author declares `pydantic==2.12.5` to resolve around it.
