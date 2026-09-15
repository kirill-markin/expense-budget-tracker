-- Restrict budget_lines.direction to the budget model's income and spend,
-- matching budget_adjustments_direction_check.
--
-- NOT VALID enforces the check on new INSERT and UPDATE writes without scanning
-- existing rows, which cannot be inspected across workspaces before deployment.

SET LOCAL lock_timeout = '30s';

ALTER TABLE public.budget_lines
  ADD CONSTRAINT budget_lines_direction_check
  CHECK (direction IN ('income', 'spend')) NOT VALID;
