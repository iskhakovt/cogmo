Containers a coding task creates through the Docker API proxy are recorded as its own. testcontainers and `docker run` work in a task again, and the task's children are removed with it.

- **Child rows.** When the daemon answers a proxy create with 201, the child's `containers` row is inserted in `starting` before the client gets its answer. The row records the task's container as its parent, depth 1, and the task's id, instance, TTL and effective resource limits. If the insert fails, the container is killed and removed, and the client gets a 500.
- **Owned children.** Ownership reads the task's own row and its children, so every request on a child the task created now reaches the daemon under its full id.
- **Lifecycle.**
  - A proxy `start` moves the row to `running` (a 304 for an already-running child counts too). If the row was already reaped, the container is killed.
  - A `DELETE` moves the row to `exited` and is forwarded with `v=true`. A true `link` is refused; the `link=False` docker-py and testcontainers-python send is read as the daemon reads it.
  - `start` takes no body, `{}` or `null`, and is forwarded with none.
  - The row is written even if the client hangs up before the daemon's answer.
  - A 17th live child is refused, counting creates still in flight. Before refusing, the proxy checks the task's children against the daemon, so ones removed by `AutoRemove` (`docker run --rm`) stop counting.
- **Cleanup.**
  - The cascade and TTL reaps now cover children too, so testcontainers' Ryuk, which is disabled in coding sessions, isn't missed.
  - Every container removal Cogmo makes passes `v=true`, so anonymous volumes go with their container.
  - The orphan pass leaves a rowless container labelled with the live instance alone for 2 minutes, which covers the moment between a create and its row.
- **Teardown.** When a task ends, the proxy stops answering its requests (503) and stops accepting connections. It waits up to 30 seconds for creates still in flight, then aborts the rest, all before the cascade removes the task's containers. A create runs to completion even if its client hangs up, so its row is written.

Network and volume policies, the registry-host rule for pulls, and the remaining upgrade checks are the last two slices (todo.md → Docker API proxy authorization boundary).
