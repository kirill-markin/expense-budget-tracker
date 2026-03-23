-- Align chat container state with the rest of workspace-scoped data.
--
-- This closes the stale-membership/revocation gap by requiring a live
-- workspace_members check in addition to matching app.user_id/app.workspace_id.

DROP POLICY chat_code_interpreter_containers_self_access ON public.chat_code_interpreter_containers;

CREATE POLICY chat_code_interpreter_containers_self_access ON public.chat_code_interpreter_containers
  FOR ALL
  USING (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    user_id = current_setting('app.user_id', true)
    AND workspace_id = current_setting('app.workspace_id', true)
    AND current_app_user_has_selected_workspace_access()
  );
