Only a coding task's sandbox session mounts the Docker API proxy socket.

- **`SessionSpec.dockerSocket`** is a required boolean, so every caller states whether its session reaches a Docker API. On Local-Docker, a session created with `true` gets the task's proxy socket at `/var/run/docker.sock`. A session created with `false` gets no proxy scope and no mount.
- **Who gets one.** A coding task's session sets `true`, because the repo under work may start containers through testcontainers or `docker compose`. Every skills session sets `false`: pool and one-shot workers, the lockfile compile, the deps reaper, and register's check, import and test sessions. So does coding teardown's salvage session, which runs only git. A skill's Python, or a git filter in a salvage tree, has no route to the daemon to inspect, exec into or kill other containers.
- **Rollback.** A failed create releases a proxy scope only if that create registered one. A salvage session shares its coding task's id, so a failed salvage create can't drop the coding session's live scope.
- **Daytona** ignores the field, since its sandboxes never reach the host daemon.
- **The wasm-tier hold.** Register's test session runs without the socket, the condition the hold waits on. Register keeps holding wasm-tier suites, recording `not_run: wasm_tier_held`, until its own change lands (todo.md → S5g wasm-tier tests).
