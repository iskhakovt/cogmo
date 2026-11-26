The Docker API proxy forwards only requests on a task's own containers and exec sessions, and denies every route it doesn't list. A coding task can no longer inspect, exec into, archive, kill or list another task's containers or Cogmo's own.

- **Ownership.** A container ref, whether a full id, a prefix or a name, is resolved through the daemon and checked against the task's `containers` rows, read from the store on every request. The request then goes out under the full id, so a rename can't redirect it. A sibling's container, Cogmo's own, a missing one and an ambiguous prefix all get the daemon's `No such container` 404, so nothing tells them apart. An exec session is owned when the task's own socket created it.
- **The task's own container.** Its lifecycle routes (`start`, `stop`, `kill`, `rename`, `DELETE` and the rest) and `PUT /archive` are refused: Cogmo owns its lifecycle, and an archive extracted onto its host-bound `/workspace` would run as host root.
- **Lists and events.** `GET /containers/json` returns only the task's containers. `GET /events` drops every line that isn't the task's, including network and volume events, which carry no task label.
- **The route table.**
  - Routes follow moby's own router, so a ref spans path segments wherever the daemon's does.
  - A route the table doesn't list is refused, which covers `POST /containers/{id}/update` and every prune, build, swarm and plugin route.
  - Image, network and volume routes stay forwarded until their own policies land, except two. `DELETE /volumes/{name}` is refused. Network connect and disconnect work only for the task's own container on `bridge`, which testcontainers' port forwarder needs.
- **The forwarded request.** The proxy always forwards the canonical path it checked, with refs rewritten and the query re-serialised, never the client's raw request target. API versions below 1.44 are refused on every route. Hop-by-hop headers are dropped in both directions, which also stops a `Trailer` header on a body-less request from crashing `cogmo serve` with an uncaught `ERR_HTTP_TRAILER_INVALID`.
- **Requests pinned.** testcontainers-node 12.2.1's real requests, captured through a logging proxy in front of the daemon, are pinned as fixtures.

Containers a task creates get no rows until the next slice, so testcontainers can create a child but every later request on it gets a 404. Child rows, and exec start without `Upgrade` as a normal request, are the next slice (todo.md → Docker API proxy authorization boundary, slice 3).
