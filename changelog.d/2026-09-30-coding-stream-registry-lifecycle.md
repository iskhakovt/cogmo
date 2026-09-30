Coding progress streams have an owned lifecycle, and release their memory. `CodingStreamingRegistry` holds a task only while something is subscribed to it, and keeps no text of its own.

- **Publishing.** The plan and execute orchestrators publish through its `planStream` and `executeStream` handles, taken right after each run's claim. A failure before the CLI starts streaming reaches the progress message too. A publish to a task without subscribers is dropped, so a replayed step body holds nothing.
- **Ending a stream.** `failed`, and an `execute_complete` reporting success, release the task before their subscribers receive them. The message ends at execute: verify publishes nothing.
- **The sweep.** Tasks that end without a stream event, such as Revise or Cancel at the plan gate or reconcile, are released by the registry's own sweep. The sweep is an unref'd ten-minute interval in the process that holds the streams, started by `CodingStreamingRegistry.create` and stopped by `close()` at shutdown. It reads only each task's id and status, and releases a task once two consecutive sweeps find it terminal or gone.

See design/coding-delegation.md → Progress stream.
