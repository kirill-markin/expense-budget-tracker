-- Separate worker role for exchange rate fetchers.
--
-- The app role had INSERT on exchange_rates, which meant any authenticated
-- user could insert fake FX rates via the SQL API (exchange_rates has no RLS
-- because it is global data). This migration:
--   1. Creates a dedicated worker role with only the permissions it needs.
--   2. Revokes INSERT on exchange_rates from app.
--
-- After this migration, worker password must be set by migrate.sh
-- (same pattern as the app role password).

-- ==========================================================================
-- 1. Create worker role
-- ==========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worker') THEN
    CREATE ROLE worker WITH LOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO worker', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO worker;
GRANT INSERT ON TABLE exchange_rates TO worker;

-- ==========================================================================
-- 2. Revoke INSERT on exchange_rates from app
-- ==========================================================================

REVOKE INSERT ON TABLE exchange_rates FROM app;
