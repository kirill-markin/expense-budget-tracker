/**
 * Direct database access: provision, revoke, and rotate per-workspace Postgres
 * credentials so users can connect with psql, DBeaver, or LLM agents.
 *
 * Show-once credential model: passwords are generated server-side and returned
 * only in the provision/rotate response. We never store plaintext passwords —
 * Postgres handles authentication internally (pg_authid stores the hash).
 *
 * Security: all functions use queryAs() which sets app.user_id and
 * app.workspace_id in a transaction. The SQL SECURITY DEFINER functions
 * verify workspace membership before any privileged operation (CREATE ROLE,
 * ALTER ROLE, DROP ROLE). Passwords are generated server-side via
 * crypto.randomBytes() and never accepted from the client.
 */
import crypto from "node:crypto";

/** Generate a 32-char alphanumeric password (a-z, A-Z, 0-9). ~190 bits of entropy, safe to paste in terminals and connection strings without escaping. Uses rejection sampling to avoid modulo bias (256 % 62 != 0). */
const generatePassword = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const limit = 248; // largest multiple of 62 that fits in a byte (62 * 4 = 248)
  const chars: Array<string> = [];
  while (chars.length < 32) {
    const bytes = crypto.randomBytes(32);
    for (const b of bytes) {
      if (b < limit && chars.length < 32) {
        chars.push(alphabet[b % alphabet.length]);
      }
    }
  }
  return chars.join("");
};

import { queryAs } from "@/server/db";

export type DirectAccessCredentials = Readonly<{
  host: string;
  port: number;
  database: string;
  username: string;
  password: string | null;
  sslmode: string;
}>;

const buildCredentials = (username: string, password: string | null): DirectAccessCredentials => ({
  host: process.env.DIRECT_ACCESS_HOST ?? process.env.DB_HOST ?? "localhost",
  port: 5432,
  database: process.env.DB_NAME ?? "tracker",
  username,
  password,
  sslmode: process.env.AUTH_MODE === "proxy" ? "require" : "disable",
});

/** Check if direct access is provisioned. Returns credentials without password (show-once model). */
export const getDirectAccessCredentials = async (
  userId: string,
  workspaceId: string,
): Promise<DirectAccessCredentials | null> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT pg_role FROM direct_access_roles WHERE workspace_id = $1",
    [workspaceId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { pg_role: string };
  return buildCredentials(row.pg_role, null);
};

/** Create a Postgres role with a random password. Returns credentials with the password — this is the only time the password is visible. Idempotent: if already provisioned, returns credentials without password (cannot recover it). */
export const provisionDirectAccess = async (
  userId: string,
  workspaceId: string,
): Promise<DirectAccessCredentials> => {
  const password = generatePassword();

  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT provision_direct_access($1, $2) AS pg_role",
    [workspaceId, password],
  );

  const pgRole = (result.rows[0] as { pg_role: string }).pg_role;

  // Check if the role was just created or already existed.
  // If it already existed, provision_direct_access ignored the new password
  // and we cannot recover the original — return null password.
  const mapping = await queryAs(
    userId,
    workspaceId,
    "SELECT created_at FROM direct_access_roles WHERE pg_role = $1",
    [pgRole],
  );

  const createdAt = new Date((mapping.rows[0] as { created_at: string }).created_at);
  const justCreated = Date.now() - createdAt.getTime() < 5000;

  return buildCredentials(pgRole, justCreated ? password : null);
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

/** Generate a new random password and update the Postgres role. Returns credentials with the new password — this is the only time it is visible. */
export const rotateDirectAccessPassword = async (
  userId: string,
  workspaceId: string,
): Promise<DirectAccessCredentials> => {
  const newPassword = generatePassword();

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
