-- Close every active session but the newest per (channel_id, platform_address),
-- so the next migration can build `uq_sessions_active_address`. The newest row
-- by UUIDv7 id is the one `resolveSession` already returns for the address.
UPDATE "channel_sessions" SET "status" = 'closed'
WHERE "status" = 'active'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("channel_id", "platform_address") "id"
    FROM "channel_sessions"
    WHERE "status" = 'active'
    ORDER BY "channel_id", "platform_address", "id" DESC
  );
