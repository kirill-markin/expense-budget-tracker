-- Anonymized demo dataset for local development and testing.

-- Workspace settings
INSERT INTO workspace_settings (id, reporting_currency)
VALUES (1, 'USD')
ON CONFLICT (id) DO NOTHING;

-- Exchange rates (sample: EUR, GBP, RUB → USD)
INSERT INTO exchange_rates (base_currency, quote_currency, rate_date, rate) VALUES
  ('EUR', 'USD', '2025-12-31', 1.0386),
  ('EUR', 'USD', '2026-01-15', 1.0290),
  ('EUR', 'USD', '2026-01-31', 1.0350),
  ('EUR', 'USD', '2026-02-15', 1.0420),
  ('GBP', 'USD', '2025-12-31', 1.2530),
  ('GBP', 'USD', '2026-01-15', 1.2180),
  ('GBP', 'USD', '2026-01-31', 1.2400),
  ('GBP', 'USD', '2026-02-15', 1.2550),
  ('RUB', 'USD', '2025-12-31', 0.01020),
  ('RUB', 'USD', '2026-01-15', 0.01005),
  ('RUB', 'USD', '2026-01-31', 0.01010),
  ('RUB', 'USD', '2026-02-15', 0.01015);

-- Ledger entries
INSERT INTO ledger_entries (entry_id, event_id, ts, account_id, amount, currency, kind, category, counterparty, note, inserted_at) VALUES
  -- Income
  ('e001', 'ev001', '2026-01-05 09:00:00+00', 'checking-usd', 5000.00, 'USD', 'income', 'salary',       'Employer Inc',   'Jan salary',       '2026-01-05 09:00:00+00'),
  ('e002', 'ev002', '2026-02-05 09:00:00+00', 'checking-usd', 5000.00, 'USD', 'income', 'salary',       'Employer Inc',   'Feb salary',       '2026-02-05 09:00:00+00'),
  ('e003', 'ev003', '2026-01-20 12:00:00+00', 'checking-eur', 800.00,  'EUR', 'income', 'freelance',    'Client GmbH',    'Consulting',       '2026-01-20 12:00:00+00'),

  -- Spending
  ('e010', 'ev010', '2026-01-08 18:30:00+00', 'checking-usd', -120.50, 'USD', 'spend',  'groceries',    'Whole Foods',     NULL,               '2026-01-08 18:30:00+00'),
  ('e011', 'ev011', '2026-01-12 10:00:00+00', 'checking-usd', -1500.00,'USD', 'spend',  'rent',         'Landlord LLC',    'Jan rent',         '2026-01-12 10:00:00+00'),
  ('e012', 'ev012', '2026-01-15 14:20:00+00', 'checking-eur', -45.00,  'EUR', 'spend',  'transport',    'Deutsche Bahn',   'Train ticket',     '2026-01-15 14:20:00+00'),
  ('e013', 'ev013', '2026-01-22 20:00:00+00', 'checking-usd', -85.00,  'USD', 'spend',  'dining',       'Restaurant',      'Dinner',           '2026-01-22 20:00:00+00'),
  ('e014', 'ev014', '2026-02-01 11:00:00+00', 'checking-usd', -1500.00,'USD', 'spend',  'rent',         'Landlord LLC',    'Feb rent',         '2026-02-01 11:00:00+00'),
  ('e015', 'ev015', '2026-02-10 16:45:00+00', 'checking-gbp', -30.00,  'GBP', 'spend',  'subscriptions','Streaming Co',    'Monthly plan',     '2026-02-10 16:45:00+00'),
  ('e016', 'ev016', '2026-02-12 09:30:00+00', 'checking-usd', -200.00, 'USD', 'spend',  'utilities',    'Electric Co',     'Feb electricity',  '2026-02-12 09:30:00+00'),

  -- Transfers
  ('e020', 'ev020', '2026-01-10 08:00:00+00', 'checking-usd', -2000.00,'USD', 'transfer', NULL,         NULL,              'To savings',       '2026-01-10 08:00:00+00'),
  ('e021', 'ev020', '2026-01-10 08:00:00+00', 'savings-usd',   2000.00,'USD', 'transfer', NULL,         NULL,              'From checking',    '2026-01-10 08:00:00+00'),
  ('e022', 'ev022', '2026-02-08 08:00:00+00', 'checking-usd', -500.00, 'USD', 'transfer', NULL,         NULL,              'To GBP account',   '2026-02-08 08:00:00+00'),
  ('e023', 'ev022', '2026-02-08 08:00:00+00', 'checking-gbp',  400.00, 'GBP', 'transfer', NULL,         NULL,              'From USD account', '2026-02-08 08:00:00+00');

-- Budget lines (base plans for Jan and Feb 2026)
INSERT INTO budget_lines (budget_month, direction, category, kind, currency, planned_value, inserted_at) VALUES
  ('2026-01-01', 'income', 'salary',        'base', 'USD', 5000.00, '2025-12-20 10:00:00+00'),
  ('2026-01-01', 'income', 'freelance',     'base', 'USD', 500.00,  '2025-12-20 10:00:00+00'),
  ('2026-01-01', 'spend',  'rent',          'base', 'USD', 1500.00, '2025-12-20 10:00:00+00'),
  ('2026-01-01', 'spend',  'groceries',     'base', 'USD', 400.00,  '2025-12-20 10:00:00+00'),
  ('2026-01-01', 'spend',  'transport',     'base', 'USD', 100.00,  '2025-12-20 10:00:00+00'),
  ('2026-01-01', 'spend',  'dining',        'base', 'USD', 200.00,  '2025-12-20 10:00:00+00'),
  ('2026-02-01', 'income', 'salary',        'base', 'USD', 5000.00, '2026-01-25 10:00:00+00'),
  ('2026-02-01', 'spend',  'rent',          'base', 'USD', 1500.00, '2026-01-25 10:00:00+00'),
  ('2026-02-01', 'spend',  'groceries',     'base', 'USD', 400.00,  '2026-01-25 10:00:00+00'),
  ('2026-02-01', 'spend',  'utilities',     'base', 'USD', 250.00,  '2026-01-25 10:00:00+00'),
  ('2026-02-01', 'spend',  'subscriptions', 'base', 'USD', 50.00,   '2026-01-25 10:00:00+00'),
  -- Modifier: one-time adjustment
  ('2026-01-01', 'spend',  'groceries',     'modifier', 'USD', -100.00, '2026-01-18 10:00:00+00');

-- Budget comments
INSERT INTO budget_comments (budget_month, direction, category, comment, inserted_at) VALUES
  ('2026-01-01', 'spend', 'groceries', 'Reduced budget due to travel', '2026-01-18 10:05:00+00'),
  ('2026-02-01', 'spend', 'utilities', 'Expected higher bill this month', '2026-01-25 10:05:00+00');
