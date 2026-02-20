-- Exchange rates: one row per currency pair per day.

CREATE TABLE IF NOT EXISTS exchange_rates (
  base_currency  TEXT    NOT NULL,
  quote_currency TEXT    NOT NULL,
  rate_date      DATE    NOT NULL,
  rate           NUMERIC NOT NULL,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (base_currency, quote_currency, rate_date)
);
