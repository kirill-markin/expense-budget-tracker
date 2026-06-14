-- Community monthly category share settings and public link keys.

CREATE SCHEMA community;

CREATE TABLE community.monthly_category_shares (
  share_id           TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id       TEXT        NOT NULL UNIQUE REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE,
  created_by_user_id TEXT        NOT NULL REFERENCES public.users(user_id),
  enabled            BOOLEAN     NOT NULL DEFAULT false,
  indexing_enabled   BOOLEAN     NOT NULL DEFAULT false,
  display_label      TEXT        NOT NULL DEFAULT '' CHECK (char_length(display_label) <= 80),
  month_from         DATE,
  month_to           DATE,
  blocked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (month_from IS NULL OR EXTRACT(DAY FROM month_from) = 1),
  CHECK (month_to IS NULL OR EXTRACT(DAY FROM month_to) = 1),
  CHECK (month_to IS NULL OR month_from IS NULL OR month_to >= month_from),
  CHECK (NOT enabled OR month_from IS NOT NULL),
  CHECK (NOT indexing_enabled OR enabled)
);

CREATE TABLE community.monthly_category_share_items (
  share_id      TEXT        NOT NULL REFERENCES community.monthly_category_shares(share_id) ON DELETE CASCADE,
  direction     TEXT        NOT NULL CHECK (direction IN ('spend', 'income')),
  category      TEXT        NOT NULL CHECK (char_length(category) <= 200),
  access_level  TEXT        NOT NULL CHECK (access_level IN ('category_only', 'monthly_values')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (share_id, direction, category)
);

CREATE TABLE community.monthly_category_share_keys (
  key_id       TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  share_id     TEXT        NOT NULL REFERENCES community.monthly_category_shares(share_id) ON DELETE CASCADE,
  public_token TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,

  CHECK (char_length(public_token) >= 32),
  CHECK (public_token ~ '^[A-Za-z0-9_-]+$')
);

CREATE UNIQUE INDEX monthly_category_share_keys_active_share_idx
  ON community.monthly_category_share_keys (share_id)
  WHERE revoked_at IS NULL;

CREATE INDEX monthly_category_share_keys_share_id_idx
  ON community.monthly_category_share_keys (share_id);

CREATE INDEX monthly_category_share_items_lookup_idx
  ON community.monthly_category_share_items (share_id, direction, access_level);

ALTER TABLE community.monthly_category_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE community.monthly_category_shares FORCE ROW LEVEL SECURITY;

CREATE POLICY monthly_category_shares_select_access
  ON community.monthly_category_shares
  FOR SELECT
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY monthly_category_shares_insert_access
  ON community.monthly_category_shares
  FOR INSERT
  WITH CHECK (
    workspace_id = current_setting('app.workspace_id', true)
    AND created_by_user_id = current_setting('app.user_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY monthly_category_shares_update_access
  ON community.monthly_category_shares
  FOR UPDATE
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  )
  WITH CHECK (
    workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

CREATE POLICY monthly_category_shares_delete_access
  ON community.monthly_category_shares
  FOR DELETE
  USING (
    workspace_id = current_setting('app.workspace_id', true)
    AND public.current_app_user_has_selected_workspace_access()
  );

ALTER TABLE community.monthly_category_share_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE community.monthly_category_share_items FORCE ROW LEVEL SECURITY;

CREATE POLICY monthly_category_share_items_workspace_access
  ON community.monthly_category_share_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM community.monthly_category_shares AS parent_share
      WHERE parent_share.share_id = monthly_category_share_items.share_id
        AND parent_share.workspace_id = current_setting('app.workspace_id', true)
        AND public.current_app_user_has_selected_workspace_access()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM community.monthly_category_shares AS parent_share
      WHERE parent_share.share_id = monthly_category_share_items.share_id
        AND parent_share.workspace_id = current_setting('app.workspace_id', true)
        AND public.current_app_user_has_selected_workspace_access()
    )
  );

ALTER TABLE community.monthly_category_share_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE community.monthly_category_share_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY monthly_category_share_keys_workspace_access
  ON community.monthly_category_share_keys
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM community.monthly_category_shares AS parent_share
      WHERE parent_share.share_id = monthly_category_share_keys.share_id
        AND parent_share.workspace_id = current_setting('app.workspace_id', true)
        AND public.current_app_user_has_selected_workspace_access()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM community.monthly_category_shares AS parent_share
      WHERE parent_share.share_id = monthly_category_share_keys.share_id
        AND parent_share.workspace_id = current_setting('app.workspace_id', true)
        AND public.current_app_user_has_selected_workspace_access()
    )
  );

REVOKE ALL ON SCHEMA community FROM PUBLIC;
REVOKE ALL ON SCHEMA community FROM api_sql_executor;
GRANT USAGE ON SCHEMA community TO app;

REVOKE ALL ON TABLE community.monthly_category_shares FROM PUBLIC;
REVOKE ALL ON TABLE community.monthly_category_shares FROM api_sql_executor;
GRANT SELECT, INSERT, DELETE ON TABLE community.monthly_category_shares TO app;
GRANT UPDATE (
  enabled,
  indexing_enabled,
  display_label,
  month_from,
  month_to,
  blocked_at,
  updated_at
) ON TABLE community.monthly_category_shares TO app;

REVOKE ALL ON TABLE community.monthly_category_share_items FROM PUBLIC;
REVOKE ALL ON TABLE community.monthly_category_share_items FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE community.monthly_category_share_items TO app;

REVOKE ALL ON TABLE community.monthly_category_share_keys FROM PUBLIC;
REVOKE ALL ON TABLE community.monthly_category_share_keys FROM api_sql_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE community.monthly_category_share_keys TO app;
