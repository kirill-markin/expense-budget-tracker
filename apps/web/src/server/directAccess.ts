/**
 * Direct database access: provision, revoke, and rotate per-workspace Postgres
 * credentials so users can connect with psql, DBeaver, or LLM agents.
 *
 * Security: all functions use queryAs() which sets app.user_id and
 * app.workspace_id in a transaction. The SQL SECURITY DEFINER functions
 * verify workspace membership before any privileged operation (CREATE ROLE,
 * ALTER ROLE, DROP ROLE). Passwords are generated server-side via
 * crypto.randomUUID() and never accepted from the client.
 */
import crypto from "node:crypto";

import { queryAs } from "@/server/db";

export type DirectAccessCredentials = Readonly<{
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslmode: string;
}>;

const buildCredentials = (username: string, password: string): DirectAccessCredentials => ({
  host: process.env.DB_HOST ?? "localhost",
  port: 5432,
  database: process.env.DB_NAME ?? "tracker",
  username,
  password,
  sslmode: process.env.AUTH_MODE === "proxy" ? "require" : "disable",
});

/** Fetch existing credentials for a workspace. Returns null if not provisioned. RLS on direct_access_roles ensures the user can only see their own workspaces. */
export const getDirectAccessCredentials = async (
  userId: string,
  workspaceId: string,
): Promise<DirectAccessCredentials | null> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT pg_role, pg_password FROM direct_access_roles WHERE workspace_id = $1",
    [workspaceId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { pg_role: string; pg_password: string };
  return buildCredentials(row.pg_role, row.pg_password);
};

/** Create a Postgres role (ws_<workspace_id>) with a random password. Idempotent — returns existing credentials if already provisioned. The SQL function runs as SECURITY DEFINER to execute CREATE ROLE. */
export const provisionDirectAccess = async (
  userId: string,
  workspaceId: string,
): Promise<DirectAccessCredentials> => {
  const password = crypto.randomUUID();

  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT provision_direct_access($1, $2) AS pg_role",
    [workspaceId, password],
  );

  const pgRole = (result.rows[0] as { pg_role: string }).pg_role;

  // If the role already existed, provision_direct_access returns it but ignores
  // the new password. Fetch the stored password for the response.
  const creds = await queryAs(
    userId,
    workspaceId,
    "SELECT pg_password FROM direct_access_roles WHERE pg_role = $1",
    [pgRole],
  );

  const storedPassword = (creds.rows[0] as { pg_password: string }).pg_password;
  return buildCredentials(pgRole, storedPassword);
};

/** Terminate active connections, revoke all grants, and drop the Postgres role. The SQL function runs as SECURITY DEFINER to execute DROP ROLE. */
export const revokeDirectAccess = async (
  userId: string,
  workspaceId: string,
): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    "SELECT revoke_direct_access($1)",
    [workspaceId],
  );
};

/** Generate a new random password and update the Postgres role. The SQL function runs as SECURITY DEFINER to execute ALTER ROLE. */
export const rotateDirectAccessPassword = async (
  userId: string,
  workspaceId: string,
): Promise<DirectAccessCredentials> => {
  const newPassword = crypto.randomUUID();

  await queryAs(
    userId,
    workspaceId,
    "SELECT rotate_direct_access_password($1, $2)",
    [workspaceId, newPassword],
  );

  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT pg_role FROM direct_access_roles WHERE workspace_id = $1",
    [workspaceId],
  );

  const pgRole = (result.rows[0] as { pg_role: string }).pg_role;
  return buildCredentials(pgRole, newPassword);
};
