### Test networks detach their endpoints before they are removed

`stopNetwork()` in `dev/containers.ts` inspects the network, force-disconnects whatever is still attached, and then stops it. The integration and e2e teardowns both go through it.

A tier stops the containers it tracks, but not everything on the network is its own: Testcontainers starts the port forwarder itself and joins it to each user-defined network, and sandbox containers are created by the supervisor through dockerode. Docker refuses to remove a network whose endpoints are still attached, so they are detached first.

Disconnecting is deliberately not stopping. The forwarder is a singleton that a concurrently-running tier may still need; it simply has no business holding this network open.

Every step is best-effort, the removal included — a failure there warns rather than throws. Teardown runs inside `globalSetup`, where an exception is indistinguishable from a failing suite in the job's exit code, so cleanup must not be able to redden a green run.
