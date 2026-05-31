CREATE EXTENSION IF NOT EXISTS vector;

-- UUID v7: native on PG18+, fallback for PG17 and below
DO $$
BEGIN
  -- Test if native uuidv7() exists (PG18+)
  PERFORM uuidv7();
EXCEPTION WHEN undefined_function THEN
  -- Fallback: pure SQL implementation for PG14-17
  -- Based on RFC 9562, uses random node + clock_seq
  CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $fn$
  DECLARE
    ts bigint;
    bytes bytea;
  BEGIN
    ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    bytes := decode(
      lpad(to_hex(ts), 12, '0') ||
      lpad(to_hex((random() * x'0fff'::int)::int | x'7000'::int), 4, '0') ||
      lpad(to_hex((random() * x'3fffffffffffffff'::bigint)::bigint | x'8000000000000000'::bigint), 16, '0'),
      'hex'
    );
    RETURN encode(bytes, 'hex')::uuid;
  END;
  $fn$ LANGUAGE plpgsql VOLATILE;
END $$;
