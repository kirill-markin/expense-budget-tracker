-- Backfill analytics.user_open_days and analytics.user_track_days with
-- approximate history from data recorded before live recording started.
--
-- The result is approximate: these sources are the best available evidence
-- of past activity, not exact per-surface records.
--
-- Open days, surface 'web':
--   - public.users.first_seen_at and last_seen_at;
--   - public.chat_sessions.created_at and last_message_at;
--   - public.llm_telemetry_spans.start_time;
--   - public.chat_turn_rate_events.created_at.
-- Open days, surface 'api':
--   - auth.agent_api_keys.created_at and last_used_at.
-- Open days, surface 'mcp':
--   - auth.oauth_connections.created_at and last_activity_at.
-- Track days:
--   - public.ledger_entries.inserted_at per workspace, attributed to every
--     member of that workspace through public.workspace_members. Most
--     workspaces are personal; a shared workspace over-attributes a day to
--     members who did not insert anything that day.
--
-- History already pruned (old chat turn rate events, expired OAuth state,
-- deleted workspaces) is not recovered. Every day is the UTC date, every
-- source joins public.users so the foreign keys hold, and every insert skips
-- rows that live recording already wrote.

SET LOCAL lock_timeout = '3s';

-- Take every lock before any work, all or nothing: live web, API and MCP
-- requests lock these tables in conflicting orders (provisioning locks users
-- before workspace_members, a ledger insert locks workspace_members before
-- users, and an open day or track day insert locks users only through its
-- foreign key after the row is written). Holding some locks while waiting for
-- the rest would stall that traffic and could deadlock with it, so each
-- attempt locks with NOWAIT, and a failed attempt releases what it took.
-- Holding SHARE on both analytics tables means no live writer has an
-- uncommitted row there that the inserts below would wait for.
DO $$
DECLARE
  v_deadline TIMESTAMPTZ := pg_catalog.clock_timestamp() + INTERVAL '30 seconds';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE
        public.workspace_members,
        public.users,
        public.ledger_entries,
        public.chat_sessions,
        public.llm_telemetry_spans,
        public.chat_turn_rate_events,
        auth.agent_api_keys
      IN ACCESS EXCLUSIVE MODE NOWAIT;
      LOCK TABLE
        analytics.user_open_days,
        analytics.user_track_days
      IN SHARE MODE NOWAIT;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF pg_catalog.clock_timestamp() >= v_deadline THEN
        RAISE EXCEPTION 'migration 0092: could not lock the backfill source and analytics tables without waiting for 30 seconds; live traffic kept one of them busy. Nothing was changed; rerun the migration.';
      END IF;
      PERFORM pg_catalog.pg_sleep(0.1);
    END;
  END LOOP;
END;
$$;

-- Forced RLS also applies to a NOSUPERUSER/NOBYPASSRLS table owner. Install
-- read policies for the migration role and drop them before commit so the
-- backfill sees every row.
DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY users_0092_backfill_read
       ON public.users FOR SELECT TO %I USING (true)',
    current_user
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY chat_sessions_0092_backfill_read
       ON public.chat_sessions FOR SELECT TO %I USING (true)',
    current_user
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY llm_telemetry_spans_0092_backfill_read
       ON public.llm_telemetry_spans FOR SELECT TO %I USING (true)',
    current_user
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY chat_turn_rate_events_0092_backfill_read
       ON public.chat_turn_rate_events FOR SELECT TO %I USING (true)',
    current_user
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY agent_api_keys_0092_backfill_read
       ON auth.agent_api_keys FOR SELECT TO %I USING (true)',
    current_user
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY ledger_entries_0092_backfill_read
       ON public.ledger_entries FOR SELECT TO %I USING (true)',
    current_user
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY workspace_members_0092_backfill_read
       ON public.workspace_members FOR SELECT TO %I USING (true)',
    current_user
  );
END;
$$;

INSERT INTO analytics.user_open_days (user_id, activity_date, surface)
SELECT DISTINCT
  source.user_id,
  (source.seen_at AT TIME ZONE 'UTC')::date,
  'web'
FROM (
  SELECT seen_user.user_id, seen_user.first_seen_at AS seen_at
  FROM public.users AS seen_user
  UNION ALL
  SELECT seen_user.user_id, seen_user.last_seen_at
  FROM public.users AS seen_user
  UNION ALL
  SELECT s.user_id, s.created_at FROM public.chat_sessions AS s
  UNION ALL
  SELECT s.user_id, s.last_message_at FROM public.chat_sessions AS s
  UNION ALL
  SELECT t.user_id, t.start_time FROM public.llm_telemetry_spans AS t
  UNION ALL
  SELECT e.user_id, e.created_at FROM public.chat_turn_rate_events AS e
) AS source
JOIN public.users AS u ON u.user_id = source.user_id
WHERE source.seen_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO analytics.user_open_days (user_id, activity_date, surface)
SELECT DISTINCT
  source.user_id,
  (source.seen_at AT TIME ZONE 'UTC')::date,
  'api'
FROM (
  SELECT k.user_id, k.created_at AS seen_at FROM auth.agent_api_keys AS k
  UNION ALL
  SELECT k.user_id, k.last_used_at FROM auth.agent_api_keys AS k
) AS source
JOIN public.users AS u ON u.user_id = source.user_id
WHERE source.seen_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO analytics.user_open_days (user_id, activity_date, surface)
SELECT DISTINCT
  source.user_id,
  (source.seen_at AT TIME ZONE 'UTC')::date,
  'mcp'
FROM (
  SELECT c.user_id, c.created_at AS seen_at FROM auth.oauth_connections AS c
  UNION ALL
  SELECT c.user_id, c.last_activity_at FROM auth.oauth_connections AS c
) AS source
JOIN public.users AS u ON u.user_id = source.user_id
WHERE source.seen_at IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO analytics.user_track_days (user_id, activity_date)
SELECT DISTINCT
  m.user_id,
  workspace_day.activity_date
FROM (
  SELECT DISTINCT
    l.workspace_id,
    (l.inserted_at AT TIME ZONE 'UTC')::date AS activity_date
  FROM public.ledger_entries AS l
) AS workspace_day
JOIN public.workspace_members AS m ON m.workspace_id = workspace_day.workspace_id
JOIN public.users AS u ON u.user_id = m.user_id
ON CONFLICT DO NOTHING;

DROP POLICY users_0092_backfill_read ON public.users;
DROP POLICY chat_sessions_0092_backfill_read ON public.chat_sessions;
DROP POLICY llm_telemetry_spans_0092_backfill_read ON public.llm_telemetry_spans;
DROP POLICY chat_turn_rate_events_0092_backfill_read ON public.chat_turn_rate_events;
DROP POLICY agent_api_keys_0092_backfill_read ON auth.agent_api_keys;
DROP POLICY ledger_entries_0092_backfill_read ON public.ledger_entries;
DROP POLICY workspace_members_0092_backfill_read ON public.workspace_members;

SET LOCAL lock_timeout = '0';
