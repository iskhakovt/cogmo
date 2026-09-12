### Test networks detach their endpoints before they are removed

`stopNetwork()` in `dev/containers.ts` inspects the network, force-disconnects whatever is still attached, and then stops it. The integration and e2e teardowns both go through it.

A tier stops the containers it tracks, but not everything on the network is its own. Testcontainers starts the port forwarder itself and joins it to each user-defined network, and sandbox containers are created by the supervisor through dockerode — neither is in the tier's list. Docker refuses to remove a network that still has endpoints, so the removal comes back `403 ... has active endpoints`, the teardown throws, and the run exits non-zero. Every test passes and the job is still red, which is a hard failure to read: the summary says `27 passed | 3 skipped` directly above `Process completed with exit code 1`.

Disconnecting is deliberately not stopping. The forwarder is a singleton that a concurrently-running tier may still need; it simply has no business holding this network open. Every step is best-effort, since a container or network that has already gone is the outcome being asked for.
