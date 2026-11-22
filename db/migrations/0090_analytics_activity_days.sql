-- Product analytics: one row per person per UTC day for opening the app and
-- for tracking a transaction.
--
-- Open days are recorded by the app through analytics.record_user_open_day,
-- which only the app role may call; restricted agent SQL roles get nothing in
-- this schema. Track days are recorded by a trigger on every ledger insert,
-- so manual and AI-made transactions count the same. Both read the acting
-- person from app.user_id, which every request context sets after
-- provisioning that person's users row.

SET LOCAL lock_timeout = '30s';

CREATE SCHEMA analytics;

REVOKE ALL ON SCHEMA analytics FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics TO app;

CREATE TABLE analytics.user_open_days (
  user_id       TEXT NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  activity_date DATE NOT NULL,
  surface       TEXT NOT NULL CHECK (surface IN ('web', 'api', 'mcp')),
  PRIMARY KEY (user_id, activity_date, surface)
);

CREATE INDEX idx_user_open_days_activity_date
  ON analytics.user_open_days (activity_date);

CREATE TABLE analytics.user_track_days (
  user_id       TEXT NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  activity_date DATE NOT NULL,
  PRIMARY KEY (user_id, activity_date)
);

CREATE INDEX idx_user_track_days_activity_date
  ON analytics.user_track_days (activity_date);

REVOKE ALL ON TABLE analytics.user_open_days FROM PUBLIC;
REVOKE ALL ON TABLE analytics.user_track_days FROM PUBLIC;

CREATE FUNCTION analytics.record_user_open_day(p_surface TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, analytics, pg_temp
AS $$
DECLARE
  v_user TEXT := current_setting('app.user_id', true);
BEGIN
  IF v_user IS NULL OR v_user = '' THEN
    RAISE EXCEPTION 'analytics.record_user_open_day: app.user_id must be set by the caller''s user context';
  END IF;

  INSERT INTO analytics.user_open_days (user_id, activity_date, surface)
  VALUES (v_user, (now() AT TIME ZONE 'UTC')::date, p_surface)
  ON CONFLICT DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION analytics.record_user_open_day(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics.record_user_open_day(TEXT) TO app;

CREATE FUNCTION analytics.record_ledger_track_day()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, analytics, pg_temp
AS $$
DECLARE
  v_user TEXT := current_setting('app.user_id', true);
BEGIN
  -- Owner scripts such as scripts/selfhost-verify/verify.mjs insert
  -- transactions with no acting person, so they record no track day.
  IF v_user IS NULL OR v_user = '' THEN
    RETURN NULL;
  END IF;

  -- A statement-level trigger also fires for an insert of zero rows.
  IF NOT EXISTS (SELECT 1 FROM inserted_rows) THEN
    RETURN NULL;
  END IF;

  INSERT INTO analytics.user_track_days (user_id, activity_date)
  VALUES (v_user, (now() AT TIME ZONE 'UTC')::date)
  ON CONFLICT DO NOTHING;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION analytics.record_ledger_track_day() FROM PUBLIC;

CREATE TRIGGER ledger_entries_record_track_day
AFTER INSERT ON public.ledger_entries
REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION analytics.record_ledger_track_day();
