The read tools are durable (Append-only step 2): `read_file`, `list_files`, `list_tasks`, `list_pipelines`, `core_memory_read` and `get_current_time` run inside a step, so a replay sends the model the output it saw rather than a fresh read. Every built-in tool is now durable; only a handler whose output is a pure function of its input stays out of a step.

The flag is part of the frozen tool table, so the deploy opens one `configuration` epoch per conversation, and a run in flight finishes on the table it froze. Two parallel-safe reads in one iteration form a parallel step group.
