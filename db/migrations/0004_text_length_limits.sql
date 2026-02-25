-- Add length limits to all user-facing TEXT columns.

-- ledger_entries
ALTER TABLE ledger_entries
  ADD CONSTRAINT chk_ledger_account_id_len   CHECK (length(account_id)   <= 200),
  ADD CONSTRAINT chk_ledger_currency_len     CHECK (length(currency)     <= 10),
  ADD CONSTRAINT chk_ledger_category_len     CHECK (length(category)     <= 200),
  ADD CONSTRAINT chk_ledger_counterparty_len CHECK (length(counterparty) <= 200),
  ADD CONSTRAINT chk_ledger_note_len         CHECK (length(note)         <= 1000),
  ADD CONSTRAINT chk_ledger_external_id_len  CHECK (length(external_id)  <= 200);

-- budget_lines
ALTER TABLE budget_lines
  ADD CONSTRAINT chk_budget_lines_category_len CHECK (length(category) <= 200),
  ADD CONSTRAINT chk_budget_lines_currency_len CHECK (length(currency) <= 10);

-- budget_comments
ALTER TABLE budget_comments
  ADD CONSTRAINT chk_budget_comments_category_len CHECK (length(category) <= 200),
  ADD CONSTRAINT chk_budget_comments_comment_len  CHECK (length(comment)  <= 2000);

-- exchange_rates
ALTER TABLE exchange_rates
  ADD CONSTRAINT chk_fx_base_currency_len  CHECK (length(base_currency)  <= 10),
  ADD CONSTRAINT chk_fx_quote_currency_len CHECK (length(quote_currency) <= 10);

-- workspaces
ALTER TABLE workspaces
  ADD CONSTRAINT chk_workspaces_name_len CHECK (length(name) <= 200);

-- workspace_settings
ALTER TABLE workspace_settings
  ADD CONSTRAINT chk_ws_settings_currency_len CHECK (length(reporting_currency) <= 10);
