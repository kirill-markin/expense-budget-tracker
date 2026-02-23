-- Allow users to self-provision their own workspace.
--
-- In AUTH_MODE=proxy, app.workspace_id is set server-side to the user's
-- Cognito sub (trusted). This INSERT-only policy lets the auto-provisioning
-- code create a workspace row matching that value before any membership exists.
-- PostgreSQL ORs policies for the same role, so the existing
-- workspace_member_access policy continues to work for subsequent reads.

CREATE POLICY workspace_self_provision ON workspaces
  FOR INSERT
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
