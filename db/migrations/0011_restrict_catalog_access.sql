-- Restrict system catalog access for direct access roles (ws_xxx).
--
-- Direct access users inherit from PUBLIC, so revoking from PUBLIC
-- automatically blocks all ws_xxx roles — no changes to
-- provision_direct_access() needed.
--
-- pg_catalog cannot be fully revoked (query planner needs pg_type,
-- pg_class, pg_attribute, etc.), so only sensitive tables are restricted.

-- information_schema: full schema introspection.
REVOKE USAGE ON SCHEMA information_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA information_schema TO app, tracker;

-- pg_roles / pg_user: listing all database roles.
REVOKE SELECT ON TABLE pg_catalog.pg_roles FROM PUBLIC;
GRANT SELECT ON TABLE pg_catalog.pg_roles TO app, tracker;

REVOKE SELECT ON TABLE pg_catalog.pg_user FROM PUBLIC;
GRANT SELECT ON TABLE pg_catalog.pg_user TO app, tracker;

-- pg_proc: function source code (hides SECURITY DEFINER logic).
REVOKE SELECT ON TABLE pg_catalog.pg_proc FROM PUBLIC;
GRANT SELECT ON TABLE pg_catalog.pg_proc TO app, tracker;
