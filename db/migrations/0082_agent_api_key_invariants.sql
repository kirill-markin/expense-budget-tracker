-- Re-assert the bounds db/migrations/0081_agent_api_key_app_insert.sql rests
-- on, in the directions that migration leaves open. This file changes no
-- schema: it either passes against the shipped schema or refuses to apply.
--
-- 0081 granted app INSERT on auth.agent_api_keys and pinned what it could
-- see: row-level security enabled and forced, the exact permissive policy set
-- with its USING and WITH CHECK expressions, app's table and column
-- privileges, the absence of any privilege for the restricted SQL roles on
-- the table and on the auth schema, and the roles app can act as. 0081 still
-- owns all of that and this file does not restate it.
--
-- What this block adds:
--   1. Roles that can act as app. 0081 tests pg_has_role('app', role,
--      'MEMBER'), which finds the roles app can reach, not the roles that
--      reach app. GRANT app TO api_sql_reader would hand a restricted SQL
--      session app's new INSERT privilege and 0081 would stay silent.
--   2. The two write paths 0081's header calls "outside what this block can
--      see": a relation layered over auth.agent_api_keys by a rewrite rule
--      (an updatable view, a view over such a view, or a rule that redirects
--      a write) that grants INSERT or UPDATE to a client role, at table or at
--      column level, and a SECURITY DEFINER routine a client role may EXECUTE
--      whose owner can write the credential table.
--
-- What stays outside both files, so it is not mistaken for covered:
--   - A superuser or BYPASSRLS role needs neither a membership nor a view to
--     write the table; both files bound only roles subject to the policies.
--   - The body of a SECURITY DEFINER routine is not read here. Assertion 2b
--     establishes the reachable pair, not what the routine's statements do.
--   - Routines in pg_catalog and information_schema are not scanned: adding
--     one there already needs the privileges this invariant assumes absent.
--   - Both files assert at apply time. Neither constrains what an operator
--     changes afterwards.
--   - Writes by auth_service, which the second policy admits for every row,
--     and by the owner of auth.agent_api_keys, are the shipped design.
--   - A grant of app carrying neither inherit nor set, which conveys none of
--     app's privileges; assertion 1 says why it is not walked.
--   - An inheritance child of auth.agent_api_keys (CREATE TABLE x () INHERITS
--     (auth.agent_api_keys)). Such a child is recorded in pg_inherits, not in
--     pg_rewrite, so assertion 2a does not reach it, yet rows written into it
--     are returned by an unqualified SELECT from the parent, which is how
--     auth.validate_agent_api_key reads keys. A grant on a child is therefore
--     a forge path neither file sees.
--   - A relation over auth.agent_api_keys whose grants live in db/views/.
--     scripts/migrate.sh applies db/views/*.sql after the migration loop and
--     re-runs those files on every deploy -- the pattern db/views/accounts.sql
--     establishes, because grants cannot live in a migration that predates the
--     view -- while this file runs exactly once. Such a relation is created
--     after this migration is recorded as applied and is never seen by it.
--   - Whether the owner of a SECURITY DEFINER routine reaches write access on
--     auth.agent_api_keys by SET ROLE to a third role. Assertion 2b tests that
--     owner with has_table_privilege, which follows inherit edges only.
--
-- 0081 is applied and the repository allows schema changes in new files only,
-- so its generic-escape message keeps its overstated reason: on a fresh
-- install against a drifted cluster that message still fires before this file
-- runs, and its remediation is correct there regardless. Every message below
-- states only the fact it established.

SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  -- Roles permitted to hold role app. Only app itself: no migration in this
  -- repository contains GRANT app TO <role>. The shipped schema makes app a
  -- member of other roles -- api_sql_executor in 0012_restrict_set_config.sql
  -- and api_sql_reader in 0066_api_sql_reader.sql, both covered by 0081's
  -- forward check -- and never the other way round. Postgres rejects circular
  -- memberships, so app cannot appear in pg_auth_members as its own member;
  -- the entry is the documented place for a membership a later migration
  -- deliberately adds.
  c_permitted_app_members CONSTANT NAME[] := ARRAY['app'::NAME];

  -- The roles that run client-facing statements: app for the web app and the
  -- machine API, and the two restricted SQL roles that run agent-authored
  -- SQL. 0081 bounds what they hold on auth.agent_api_keys directly; the
  -- assertions below bound what they can reach indirectly.
  c_client_roles CONSTANT NAME[] := ARRAY[
    'app'::NAME,
    'api_sql_reader'::NAME,
    'api_sql_executor'::NAME
  ];

  -- Every SECURITY DEFINER routine the migrations up to 0081 install, with
  -- the migration that creates it. Each is owned by the role that applied the
  -- migrations, which can write auth.agent_api_keys, so all of them match the
  -- reachable pair of assertion 2b and are listed by exact schema and name
  -- rather than by a pattern. The match is on schema and name only, so every
  -- overload of a listed name is permitted, including an overload the shipped
  -- schema never installed. That is deliberate: the shipped overloads of a
  -- name are the same helper (public.create_workspace_for_current_user exists
  -- as (text) from 0016 and as (text, text) from 0033), and keying the list on
  -- a rendered argument list instead would have to reproduce
  -- pg_get_function_identity_arguments exactly for every shipped overload,
  -- where one rendering mismatch fails the migration on a healthy cluster. A
  -- routine whose schema and name are outside this list is one the shipped
  -- schema did not install under that name.
  c_permitted_security_definer_routines CONSTANT TEXT[] := ARRAY[
    'public.get_user_workspace_ids',                          -- 0002, 0011
    'public.provision_direct_access',                         -- 0002, 0006
    'public.rotate_direct_access_password',                   -- 0002
    'public.revoke_direct_access',                            -- 0002
    'public.on_workspace_member_removed',                     -- 0002
    'public.validate_api_key',                                -- 0007
    'public.on_workspace_member_removed_api_keys',            -- 0007
    'public.provision_personal_workspace_for_current_user',   -- 0016, 0033
    'public.create_workspace_for_current_user',               -- 0016, 0033
    'public.current_app_user_has_selected_workspace_access',  -- 0026, 0054
    'public.delete_workspace_for_current_user',               -- 0035, 0054
    'public.ensure_current_user_has_workspace',               -- 0039
    'auth.validate_agent_api_key',                            -- 0018
    'auth.touch_agent_api_key_usage',                         -- 0018
    'auth.sync_authenticated_user',                           -- 0018, 0080
    'auth.get_single_workspace_id',                           -- 0022
    'auth.resolve_login_workspace_id',                        -- 0039
    'auth.validate_oauth_access_token',                       -- 0067
    'auth.list_current_user_oauth_connections',               -- 0068
    'auth.revoke_current_user_oauth_connection',              -- 0068
    'auth.record_oauth_connection_activity',                  -- 0069
    'auth.cleanup_expired_oauth_transient_state',             -- 0069
    'auth.enqueue_revoked_oauth_connection_cleanup',          -- 0071
    'auth.get_oauth_owner_account_state',                     -- 0079
    'auth.mirror_authenticated_user',                         -- 0079
    'community.read_public_monthly_category_share',           -- 0047, 0049, 0050
    'community.read_public_monthly_category_share_metadata'   -- 0048
  ];

  -- has_table_privilege reads a comma-separated list as "any of these", so
  -- this is the filter for an owner that can write the credential table. The
  -- exception reports the privileges that owner actually holds, not the list.
  c_write_privileges CONSTANT TEXT := 'INSERT, UPDATE, DELETE';

  v_app_member RECORD;
  v_app_oid OID;
  v_dependency_kind TEXT;
  v_dependent_relation RECORD;
  v_grant_detail TEXT;
  v_membership_detail TEXT;
  v_remediation TEXT;
  v_role_name NAME;
  v_routine RECORD;
  v_routine_signature TEXT;
  v_table_oid OID;
BEGIN
  -- Only what the assertions below need in order to run. The state of the
  -- table, its policies and its grants stays 0081's assertion.
  v_table_oid := pg_catalog.to_regclass('auth.agent_api_keys')::OID;

  IF v_table_oid IS NULL THEN
    RAISE EXCEPTION
      'agent API key write path invariant failed: table auth.agent_api_keys does not exist. Apply db/migrations/0018_agent_auth.sql first, then re-run this migration';
  END IF;

  FOREACH v_role_name IN ARRAY c_client_roles
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_record
      WHERE role_record.rolname = v_role_name
    )
    THEN
      RAISE EXCEPTION
        'agent API key write path invariant failed: required role % does not exist, so what that role can reach on auth.agent_api_keys cannot be tested',
        v_role_name;
    END IF;
  END LOOP;

  SELECT role_record.oid
    INTO v_app_oid
    FROM pg_catalog.pg_roles AS role_record
    WHERE role_record.rolname = 'app';

  -- 1. Reverse membership: the roles that can act as app.
  --
  -- pg_auth_members is walked directly rather than through pg_has_role,
  -- because pg_has_role reports every superuser as a member of every role.
  -- That would report the role applying this migration and would prove
  -- nothing: a superuser reaches app's privileges with no grant at all, and
  -- nothing here bounds it. The recursive walk reports exactly the roles an
  -- operator granted app to, directly or through a chain.
  --
  -- Two closures are walked rather than one, and they are not combined.
  -- PostgreSQL resolves privilege inheritance by following inherit_option on
  -- every edge of a chain, and SET ROLE by following set_option on every edge,
  -- so the two edge types do not compose: in a chain
  -- X --inherit only--> Y --set only--> app, X inherits nothing from app and
  -- cannot SET ROLE app. Accepting either option per edge would report X and
  -- refuse to apply on a cluster where nothing reaches app.
  --
  -- A grant carrying neither option appears in neither closure. It conveys
  -- none of app's privileges and no SET ROLE app; PostgreSQL 16 and later
  -- records exactly such an administrative grant to the creator of a role when
  -- that creator is not a superuser, which is how a managed cluster creates
  -- app. A role holding that grant WITH ADMIN OPTION can still re-grant app to
  -- itself with inherit or set true, which is an operator action of the same
  -- kind neither this file nor 0081 can bound.
  FOR v_app_member IN
    WITH RECURSIVE inherit_member AS (
      SELECT
        direct_grant.member AS member_oid,
        direct_grant.roleid AS granted_role_oid
      FROM pg_catalog.pg_auth_members AS direct_grant
      WHERE direct_grant.roleid = v_app_oid
        AND direct_grant.inherit_option
      UNION
      SELECT
        indirect_grant.member,
        indirect_grant.roleid
      FROM pg_catalog.pg_auth_members AS indirect_grant
      JOIN inherit_member ON inherit_member.member_oid = indirect_grant.roleid
      WHERE indirect_grant.inherit_option
    ),
    set_member AS (
      SELECT
        direct_grant.member AS member_oid,
        direct_grant.roleid AS granted_role_oid
      FROM pg_catalog.pg_auth_members AS direct_grant
      WHERE direct_grant.roleid = v_app_oid
        AND direct_grant.set_option
      UNION
      SELECT
        indirect_grant.member,
        indirect_grant.roleid
      FROM pg_catalog.pg_auth_members AS indirect_grant
      JOIN set_member ON set_member.member_oid = indirect_grant.roleid
      WHERE indirect_grant.set_option
    ),
    app_member AS (
      SELECT
        inherit_member.member_oid,
        inherit_member.granted_role_oid,
        'inherit'::TEXT AS reach_option
      FROM inherit_member
      UNION ALL
      SELECT
        set_member.member_oid,
        set_member.granted_role_oid,
        'set'::TEXT
      FROM set_member
    )
    SELECT
      member_role.rolname AS member_name,
      granted_role.rolname AS granted_role_name,
      app_member.reach_option,
      (app_member.granted_role_oid = v_app_oid) AS is_direct
    FROM app_member
    JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = app_member.member_oid
    JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = app_member.granted_role_oid
    WHERE NOT (member_role.rolname = ANY (c_permitted_app_members))
    -- Only the first offender is reported, direct members of app first.
    ORDER BY
      (app_member.granted_role_oid = v_app_oid) DESC,
      member_role.rolname,
      app_member.reach_option
  LOOP
    IF v_app_member.is_direct THEN
      v_membership_detail := pg_catalog.format(
        'role %I is a direct member of role app through a grant carrying %s true, so it reaches app''s privileges on auth.agent_api_keys %s',
        v_app_member.member_name,
        v_app_member.reach_option,
        CASE v_app_member.reach_option
          WHEN 'inherit' THEN 'by inheritance'
          ELSE 'by SET ROLE app'
        END
      );
    ELSE
      v_membership_detail := pg_catalog.format(
        'role %I is a member of role %I, and every grant on the chain from role %I to role app carries %s true, so role %I reaches app''s privileges on auth.agent_api_keys %s',
        v_app_member.member_name,
        v_app_member.granted_role_name,
        v_app_member.member_name,
        v_app_member.reach_option,
        v_app_member.member_name,
        CASE v_app_member.reach_option
          WHEN 'inherit' THEN 'by inheritance'
          ELSE 'by SET ROLE app'
        END
      );
    END IF;

    v_remediation := pg_catalog.format(
      'Run REVOKE %I FROM %I, then re-run this migration',
      v_app_member.granted_role_name,
      v_app_member.member_name
    );

    RAISE EXCEPTION
      'agent API key write path invariant failed: %. db/migrations/0081_agent_api_key_app_insert.sql grants role app INSERT on auth.agent_api_keys, no migration in this repository grants role app to any role, and 0081 tests only the roles app can act as, not the roles that can act as app. %',
      v_membership_detail,
      v_remediation;
  END LOOP;

  -- 2a. Write paths through another relation.
  --
  -- A view over auth.agent_api_keys, a view over that view, or a rule that
  -- redirects a write into it, is a relation of its own: its grants are not
  -- the grants 0081 pins on the table, and a view reads and writes its base
  -- table with the view owner's privileges unless it is defined WITH
  -- (security_invoker = true). Dependants are found through pg_depend and
  -- pg_rewrite rather than by name, and the walk is recursive so a second
  -- layer cannot hide behind the first. Only a grant is a violation: a
  -- dependent relation that grants nothing to a client role is no path.
  --
  -- Both grant forms are tested, as 0081 tests both on the base table: a
  -- column grant does not show at table level, and a column-level INSERT on
  -- an auto-updatable view is enough to insert the columns it names. Whether
  -- the dependency is direct or transitive is carried through, so the message
  -- can say which it read.
  FOR v_dependent_relation IN
    WITH RECURSIVE dependent_relation AS (
      SELECT
        rewrite_rule.ev_class AS relation_oid,
        TRUE AS is_direct
      FROM pg_catalog.pg_depend AS dependency
      JOIN pg_catalog.pg_rewrite AS rewrite_rule
        ON rewrite_rule.oid = dependency.objid
      WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
        AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
        AND dependency.refobjid = v_table_oid
        AND rewrite_rule.ev_class <> v_table_oid
      UNION
      SELECT
        rewrite_rule.ev_class,
        FALSE
      FROM pg_catalog.pg_depend AS dependency
      JOIN pg_catalog.pg_rewrite AS rewrite_rule
        ON rewrite_rule.oid = dependency.objid
      JOIN dependent_relation
        ON dependent_relation.relation_oid = dependency.refobjid
      WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
        AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
        AND rewrite_rule.ev_class <> dependent_relation.relation_oid
        AND rewrite_rule.ev_class <> v_table_oid
    ),
    -- A relation reachable both ways is reported as the direct dependant it
    -- also is.
    dependent_relation_scope AS (
      SELECT
        dependent_relation.relation_oid,
        pg_catalog.bool_or(dependent_relation.is_direct) AS is_direct
      FROM dependent_relation
      GROUP BY dependent_relation.relation_oid
    )
    SELECT
      relation_namespace.nspname AS schema_name,
      relation.relname AS relation_name,
      relation.relkind::TEXT AS relation_kind,
      dependent_relation_scope.is_direct,
      client_role.role_name,
      granted.privilege_name,
      column_grant.column_name
    FROM dependent_relation_scope
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = dependent_relation_scope.relation_oid
    JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    CROSS JOIN pg_catalog.unnest(c_client_roles) AS client_role(role_name)
    CROSS JOIN pg_catalog.unnest(ARRAY['INSERT'::TEXT, 'UPDATE'::TEXT])
      AS granted(privilege_name)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.has_table_privilege(
        client_role.role_name,
        relation.oid,
        granted.privilege_name
      ) AS is_table_level
    ) AS table_grant
    -- Only consulted when the table level is silent, so a table-level grant
    -- reports no column. has_column_privilege is true for every column when
    -- the privilege is held table-wide, which would otherwise mislabel it.
    LEFT JOIN LATERAL (
      SELECT attribute.attname AS column_name
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND pg_catalog.has_column_privilege(
          client_role.role_name,
          relation.oid,
          attribute.attname,
          granted.privilege_name
        )
      ORDER BY attribute.attnum
      LIMIT 1
    ) AS column_grant
      ON NOT table_grant.is_table_level
    WHERE table_grant.is_table_level
      OR column_grant.column_name IS NOT NULL
    ORDER BY
      relation_namespace.nspname,
      relation.relname,
      client_role.role_name,
      granted.privilege_name
  LOOP
    IF v_dependent_relation.is_direct THEN
      v_dependency_kind := 'direct';
    ELSE
      v_dependency_kind := 'transitive';
    END IF;

    IF v_dependent_relation.column_name IS NULL THEN
      v_grant_detail := pg_catalog.format(
        'grants %s on that relation to role %I at table level',
        v_dependent_relation.privilege_name,
        v_dependent_relation.role_name
      );
      v_remediation := pg_catalog.format(
        'Run REVOKE %s ON %I.%I FROM %I',
        v_dependent_relation.privilege_name,
        v_dependent_relation.schema_name,
        v_dependent_relation.relation_name,
        v_dependent_relation.role_name
      );
    ELSE
      v_grant_detail := pg_catalog.format(
        'grants %s on its column %I to role %I, a column grant that does not show at table level',
        v_dependent_relation.privilege_name,
        v_dependent_relation.column_name,
        v_dependent_relation.role_name
      );
      v_remediation := pg_catalog.format(
        'Run REVOKE %s (%I) ON %I.%I FROM %I',
        v_dependent_relation.privilege_name,
        v_dependent_relation.column_name,
        v_dependent_relation.schema_name,
        v_dependent_relation.relation_name,
        v_dependent_relation.role_name
      );
    END IF;

    -- The privilege is counted as the role effectively holds it, so a direct
    -- REVOKE can succeed and change nothing when the grantee is PUBLIC or a
    -- role this one inherits.
    v_remediation := v_remediation || pg_catalog.format(
      ', then re-run this migration. The privilege is counted including inherited and PUBLIC grants, so if that REVOKE leaves this check failing, revoke it from PUBLIC or from the role %I holds it through',
      v_dependent_relation.role_name
    );

    RAISE EXCEPTION
      'agent API key write path invariant failed: relation %.% (relkind %) is a % dependant of auth.agent_api_keys through a rewrite rule and %. db/migrations/0081_agent_api_key_app_insert.sql pins the privileges and the policies on auth.agent_api_keys itself and not on relations layered over it. This block read the dependency and the grant and nothing else: not whether that relation is updatable into auth.agent_api_keys, not whether an INSTEAD rule or trigger redirects writes into it, not what its owner may do, and not whether it is security_invoker. If that relation is updatable into auth.agent_api_keys, this grant is a write path 0081 does not cover. %',
      v_dependent_relation.schema_name,
      v_dependent_relation.relation_name,
      v_dependent_relation.relation_kind,
      v_dependency_kind,
      v_grant_detail,
      v_remediation;
  END LOOP;

  -- 2b. Write paths through a SECURITY DEFINER routine.
  --
  -- Such a routine runs its body with its owner's privileges, so an owner
  -- that can write auth.agent_api_keys together with a client role that can
  -- EXECUTE the routine is the reachable pair. Both halves are read from the
  -- catalog: the owner's INSERT, UPDATE or DELETE on the credential table,
  -- and EXECUTE held directly, by inheritance or through PUBLIC.
  FOR v_routine IN
    SELECT
      routine_namespace.nspname AS schema_name,
      routine.proname AS routine_name,
      pg_catalog.pg_get_function_identity_arguments(routine.oid) AS routine_arguments,
      routine.proowner::REGROLE::NAME AS owner_name,
      (
        SELECT pg_catalog.string_agg(
          write_privilege.privilege_name,
          ', ' ORDER BY write_privilege.privilege_name
        )
        FROM pg_catalog.unnest(
          ARRAY['INSERT'::TEXT, 'UPDATE'::TEXT, 'DELETE'::TEXT]
        ) AS write_privilege(privilege_name)
        WHERE pg_catalog.has_table_privilege(
          routine.proowner::REGROLE::NAME,
          v_table_oid,
          write_privilege.privilege_name
        )
      ) AS owner_write_privileges,
      (
        SELECT pg_catalog.string_agg(
          pg_catalog.quote_ident(caller.role_name),
          ', ' ORDER BY caller.role_name
        )
        FROM pg_catalog.unnest(c_client_roles) AS caller(role_name)
        WHERE pg_catalog.has_function_privilege(
          caller.role_name,
          routine.oid,
          'EXECUTE'
        )
      ) AS caller_role_names
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS routine_namespace
      ON routine_namespace.oid = routine.pronamespace
    WHERE routine.prosecdef
      AND routine_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT (
        routine_namespace.nspname || '.' || routine.proname
          = ANY (c_permitted_security_definer_routines)
      )
      AND pg_catalog.has_table_privilege(
        routine.proowner::REGROLE::NAME,
        v_table_oid,
        c_write_privileges
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(c_client_roles) AS caller(role_name)
        WHERE pg_catalog.has_function_privilege(
          caller.role_name,
          routine.oid,
          'EXECUTE'
        )
      )
    ORDER BY routine_namespace.nspname, routine.proname, routine.oid
  LOOP
    v_routine_signature := pg_catalog.format(
      '%I.%I(%s)',
      v_routine.schema_name,
      v_routine.routine_name,
      v_routine.routine_arguments
    );
    v_remediation := pg_catalog.format(
      'Run REVOKE EXECUTE ON ROUTINE %s FROM %s, or redefine the routine SECURITY INVOKER, or reassign it to a role that cannot write auth.agent_api_keys, then re-run this migration. EXECUTE is counted including inherited and PUBLIC grants, so if that REVOKE leaves this check failing, revoke it from PUBLIC or from the role the EXECUTE is held through',
      v_routine_signature,
      v_routine.caller_role_names
    );

    RAISE EXCEPTION
      'agent API key write path invariant failed: SECURITY DEFINER routine % is owned by role %, which holds % on auth.agent_api_keys, and % may EXECUTE it, including inherited and PUBLIC grants. A SECURITY DEFINER routine runs its body with its owner''s privileges, so this pair is a write path that does not run as app, and db/migrations/0081_agent_api_key_app_insert.sql checks only statements that do. The established facts are that pair and that no migration up to 0081 installs a SECURITY DEFINER routine under that name; this block did not read the routine''s body and does not claim it touches the table. %',
      v_routine_signature,
      v_routine.owner_name,
      v_routine.owner_write_privileges,
      v_routine.caller_role_names,
      v_remediation;
  END LOOP;
END;
$$;

SET LOCAL lock_timeout = '0';
