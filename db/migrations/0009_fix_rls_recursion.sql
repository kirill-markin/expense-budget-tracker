-- Fix infinite RLS recursion between workspace_members and direct_access_roles.
--
-- The cycle:
--   workspace_members.role_restriction  → subquery on direct_access_roles
--   direct_access_roles.app_access      → subquery on workspace_members  → ∞
--
-- Postgres detects the cycle at query rewrite time (before execution),
-- so OR short-circuiting cannot prevent it.
--
-- Fix: replace the raw subquery in direct_access_roles.app_access with a
-- SECURITY DEFINER function. The function runs as the table owner (tracker),
-- which bypasses RLS on workspace_members, breaking the cycle.

CREATE OR REPLACE FUNCTION get_user_workspace_ids(p_user_id TEXT)
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wm.workspace_id
  FROM workspace_members wm
  WHERE wm.user_id = p_user_id;
$$;

-- Recreate app_access policy using the helper function instead of a direct subquery.
DROP POLICY app_access ON direct_access_roles;

CREATE POLICY app_access ON direct_access_roles
  USING (
    current_user = 'app'
    AND workspace_id IN (
      SELECT get_user_workspace_ids(current_setting('app.user_id', true))
    )
  );
