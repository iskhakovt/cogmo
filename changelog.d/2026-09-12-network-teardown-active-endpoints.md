### Test networks detach their endpoints before they are removed

`stopNetwork()` in `dev/containers.ts` inspects the network, force-disconnects whatever is still attached, and then removes it. The integration and e2e teardowns both go through it, and the container-stop loop that precedes it is guarded the same way.

Docker refuses to remove a network that still has endpoints. Teardown runs inside `globalSetup`, where a throw is indistinguishable from a failing suite in the job's exit code, so an attachment surviving the tier's own stop pass turns a green run red. Which attachments those are is not currently identified — three were present on one local run — so the detach covers whatever is there rather than targeting a particular kind of container.

Disconnecting is deliberately not stopping: whatever holds the network may belong to a concurrently-running tier, and the only claim being made is that it should not hold this network open.

Cleanup is best-effort throughout, removal included — a failure warns rather than throws, and names the endpoints seen, since that list is what identifies the holder and is not recoverable afterwards. The trade is deliberate: a recurrence is a warning rather than a red job, and a leaked network costs an address-pool slot on a long-lived machine.
