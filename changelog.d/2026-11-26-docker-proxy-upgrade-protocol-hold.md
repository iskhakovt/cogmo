The Docker API proxy checks an upgraded stream's protocol and holds the client's later bytes until the daemon has switched.

- **Protocol per route.** An exec start or `/attach` is upgraded only to `tcp`, and `/attach/ws` only to `websocket`, compared without case. Any other `Upgrade` value gets 403 before any lookup. The daemon switches an exec start or an attach to whatever value it is sent, so the proxy is the only check there.
- **Upgrades on other routes.** An upgrade on a listed route that is not a stream route gets 403, as one on an unlisted route does.
- **Chunked bodies.** An upgrade with a chunked body gets 400. The Docker CLI and docker-modem frame theirs by length.
- **Held bytes.** Bytes the client sends after an upgrade's body reach the daemon only after its `101`. Any other answer, such as a detached exec start's 200 or a 404 for an exec the daemon no longer has, is relayed with `Connection: close`, and both connections end. So a request pipelined behind a refused upgrade never reaches the daemon, even one that keeps the connection open. A refusal that ends early or passes 16 MiB gets 502.

`docker exec` (with `-it`, `-i` and `-d`) and `docker attach` work through the proxy. Network and volume policies and the registry-host rule for pulls are the last slice (todo.md → Docker API proxy authorization boundary).
