-- FX hard cutover.
--
-- New architecture:
-- 1. fx_rates_raw stores canonical source rates only against the internal
--    pivot currency USD. Worker fetchers write only here.
-- 2. fx_rates_daily stores query-ready daily all-pairs rates with carry-forward
--    coverage for weekends and holidays. All application reads use this table.
--
-- We intentionally do not preserve backward compatibility with exchange_rates.
-- Data is migrated, application code switches over, and the legacy table is
-- dropped in the same cutover.

CREATE TABLE fx_rates_raw (
  base_currency  TEXT        NOT NULL CHECK (length(base_currency) <= 10),
  quote_currency TEXT        NOT NULL CHECK (length(quote_currency) <= 10),
  rate_date      DATE        NOT NULL,
  rate           NUMERIC     NOT NULL,
  source         TEXT        NOT NULL CHECK (length(source) <= 50),
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (base_currency, quote_currency, rate_date),
  CHECK (quote_currency = 'USD')
);

CREATE INDEX idx_fx_rates_raw_quote_base_date
  ON fx_rates_raw (quote_currency, base_currency, rate_date)
  INCLUDE (rate, source);

COMMENT ON TABLE fx_rates_raw IS
  'Canonical FX source-of-truth. The worker ingests raw daily market rates here using USD as the internal pivot currency.';
COMMENT ON COLUMN fx_rates_raw.quote_currency IS
  'Internal pivot currency. Reads never use this table directly; application queries read only fx_rates_daily.';
COMMENT ON COLUMN fx_rates_raw.source IS
  'Upstream source identifier such as ecb, cbr, nbs, nbu, or usdt.';

CREATE TABLE fx_rates_daily (
  base_currency    TEXT        NOT NULL CHECK (length(base_currency) <= 10),
  quote_currency   TEXT        NOT NULL CHECK (length(quote_currency) <= 10),
  calendar_date    DATE        NOT NULL,
  rate             NUMERIC     NOT NULL,
  source_rate_date DATE        NOT NULL,
  inserted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (base_currency, quote_currency, calendar_date)
);

CREATE INDEX idx_fx_rates_daily_quote_base_date
  ON fx_rates_daily (quote_currency, base_currency, calendar_date)
  INCLUDE (rate, source_rate_date);

COMMENT ON TABLE fx_rates_daily IS
  'Query-ready daily FX read model. Stores every supported base->quote pair for every calendar day so dashboard queries can use exact-date joins.';
COMMENT ON COLUMN fx_rates_daily.source_rate_date IS
  'Latest raw market date that contributed to this daily rate. Identity rows use calendar_date so carry-forward is explicit.';

INSERT INTO fx_rates_raw (
  base_currency,
  quote_currency,
  rate_date,
  rate,
  source,
  inserted_at
)
SELECT
  base_currency,
  quote_currency,
  rate_date,
  rate,
  'legacy_exchange_rates',
  inserted_at
FROM exchange_rates;

WITH bounds AS (
  SELECT
    MIN(rate_date) AS min_date,
    MAX(rate_date) AS max_date
  FROM fx_rates_raw
),
validated_bounds AS (
  SELECT min_date, max_date
  FROM bounds
  WHERE min_date IS NOT NULL
    AND max_date IS NOT NULL
),
raw_ranges AS (
  SELECT
    base_currency AS currency,
    rate_date AS range_start,
    COALESCE(
      LEAD(rate_date) OVER (
        PARTITION BY base_currency
        ORDER BY rate_date
      ) - INTERVAL '1 day',
      (SELECT max_date FROM validated_bounds)
    )::date AS range_end,
    rate,
    rate_date AS source_rate_date
  FROM fx_rates_raw
),
usd_daily AS (
  SELECT
    'USD'::text AS currency,
    d::date AS calendar_date,
    1::numeric AS rate_to_usd,
    d::date AS source_rate_date
  FROM validated_bounds vb
  CROSS JOIN LATERAL generate_series(vb.min_date, vb.max_date, INTERVAL '1 day') AS d
),
pivot_daily AS (
  SELECT
    rr.currency,
    d::date AS calendar_date,
    rr.rate,
    rr.source_rate_date
  FROM raw_ranges rr
  CROSS JOIN LATERAL generate_series(rr.range_start, rr.range_end, INTERVAL '1 day') AS d
  UNION ALL
  SELECT
    ud.currency,
    ud.calendar_date,
    ud.rate_to_usd AS rate,
    ud.source_rate_date
  FROM usd_daily ud
)
INSERT INTO fx_rates_daily (
  base_currency,
  quote_currency,
  calendar_date,
  rate,
  source_rate_date
)
SELECT
  base.currency AS base_currency,
  quote.currency AS quote_currency,
  base.calendar_date,
  CASE
    WHEN base.currency = quote.currency THEN 1::numeric
    ELSE ROUND((base.rate / quote.rate)::numeric, 9)
  END AS rate,
  CASE
    WHEN base.currency = quote.currency THEN base.calendar_date
    ELSE GREATEST(base.source_rate_date, quote.source_rate_date)
  END AS source_rate_date
FROM pivot_daily base
INNER JOIN pivot_daily quote
  ON quote.calendar_date = base.calendar_date;

GRANT SELECT ON TABLE fx_rates_raw TO app;
GRANT SELECT ON TABLE fx_rates_daily TO app;

GRANT SELECT, INSERT ON TABLE fx_rates_raw TO worker;
GRANT SELECT, INSERT, TRUNCATE ON TABLE fx_rates_daily TO worker;

GRANT SELECT ON TABLE fx_rates_raw TO api_sql_executor;
GRANT SELECT ON TABLE fx_rates_daily TO api_sql_executor;

DROP TABLE exchange_rates;
