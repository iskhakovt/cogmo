The bootstrap lookups that pick one row out of several order by `id`, so each returns the oldest row: `getDefaultProfile`, `getFirstUser` and `getChannelByType`. `id` is UUIDv7, so it follows creation order. Without the order, Postgres guarantees no particular row. A sequential scan returns the first row in the heap, and that changes when a row is edited in place or a new row reuses freed space.

In practice:
- A restart after editing the seeded profile can boot with any other profile as the default, with that profile's model and tool set.
- `channels.type` is not unique, and rotating a channel's credentials moves its row.

PGlite store tests pin each case: an edited profile, a user row landing in a vacuumed gap, and a rotated channel.
