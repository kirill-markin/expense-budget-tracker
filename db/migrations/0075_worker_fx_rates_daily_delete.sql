-- Let the worker role delete rows from fx_rates_daily.
--
-- 0034_fx_rates_cutover.sql granted only SELECT, INSERT, TRUNCATE, so the FX
-- worker can rebuild the table only by truncating all of it. DELETE lets the
-- windowed recompute remove just the calendar dates it recomputes. The
-- TRUNCATE grant stays because the currently deployed rebuild still truncates.

GRANT DELETE ON TABLE fx_rates_daily TO worker;
