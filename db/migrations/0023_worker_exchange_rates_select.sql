-- Worker fetchers read existing exchange_rates ranges before inserting updates.
-- Grant SELECT so the worker role can query the same table it writes to.

GRANT SELECT ON TABLE exchange_rates TO worker;
