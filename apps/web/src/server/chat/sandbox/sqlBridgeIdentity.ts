/**
 * The identity the sandbox SQL bridge runs as. The proxy strips the identity
 * headers on the bridge path, because the signed capability is its only
 * authentication, so the header-based contexts the chat's own SQL tools run
 * in cannot serve it. The capability's user id is trusted because the
 * capability is signed; the rest of that user's identity is read from the
 * identity mirror, and every database context of a bridge call binds it.
 * Provisioning under that identity still re-reads workspace membership, so a
 * user removed from the workspace is refused.
 */
import { z } from "zod";
import type { ValidatedExpenseSql } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  execWholeQueryWithDependencies,
  type ChatSqlExecutionContext,
  type ChatSqlTarget,
  type ExecQueryDependencies,
  type QueryResult,
} from "@/server/chat/shared";
import { lockUncancelledChatTurnForMutationWithQuery } from "@/server/chat/store/turnCancellationStore";
import {
  withReadOnlyRestrictedTrustedIdentityContext,
  withTrustedIdentityContext,
  withUserOnlyContext,
} from "@/server/db";
import { type QueryFn } from "@/server/db/contextRunner";
import { type UserIdentity } from "@/server/users";

const SELECT_STORED_IDENTITY_SQL = `SELECT user_id, email, email_verified, cognito_status, cognito_enabled
  FROM users
  WHERE user_id = $1`;

const storedIdentityRowSchema = z.object({
  user_id: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean(),
  cognito_status: z.string().min(1),
  cognito_enabled: z.boolean(),
});

export class ChatSandboxSqlAccountMissingError extends Error {
  public readonly userId: string;

  public constructor(userId: string) {
    super(`User ${userId} named by the chat sandbox SQL capability has no row in the users identity mirror`);
    this.name = "ChatSandboxSqlAccountMissingError";
    this.userId = userId;
  }
}

/**
 * The stored row, not a fresh claim: provisioning writes it back unchanged, so
 * a bridge call can neither raise the stored account state nor move
 * email_verified.
 */
const loadChatSandboxSqlIdentity = async (userId: string): Promise<UserIdentity> => {
  const result = await withUserOnlyContext(
    userId,
    async (queryFn) => queryFn(SELECT_STORED_IDENTITY_SQL, [userId]),
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ChatSandboxSqlAccountMissingError(userId);
  }
  const parsed = storedIdentityRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`The users row of user ${userId} has an invalid identity shape: ${parsed.error.message}`);
  }
  return {
    userId: parsed.data.user_id,
    email: parsed.data.email,
    emailVerified: parsed.data.email_verified,
    cognitoStatus: parsed.data.cognito_status,
    cognitoEnabled: parsed.data.cognito_enabled,
  };
};

/** The bridge's counterpart of withUserContext. */
export const withChatSandboxSqlUserContext = async <T>(
  userId: string,
  workspaceId: string,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> =>
  withTrustedIdentityContext(await loadChatSandboxSqlIdentity(userId), workspaceId, callback);

const withChatSandboxSqlReadOnlyRestrictedUserContext = async <T>(
  userId: string,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> =>
  withReadOnlyRestrictedTrustedIdentityContext(
    await loadChatSandboxSqlIdentity(userId),
    workspaceId,
    statementTimeoutMs,
    callback,
  );

const CHAT_SANDBOX_SQL_EXEC_QUERY_DEPENDENCIES: ExecQueryDependencies = {
  withUserContext: withChatSandboxSqlUserContext,
  withReadOnlyRestrictedUserContext: withChatSandboxSqlReadOnlyRestrictedUserContext,
  lockUncancelledChatTurnForMutationWithQuery,
  now: Date.now,
};

/** The chat's own SQL execution, answered whole, for the capability's stored identity. */
export const execChatSandboxSqlQuery = async (
  validated: ValidatedExpenseSql,
  context: ChatSqlExecutionContext,
  target: ChatSqlTarget,
): Promise<QueryResult> =>
  execWholeQueryWithDependencies(validated, context, target, CHAT_SANDBOX_SQL_EXEC_QUERY_DEPENDENCIES);
