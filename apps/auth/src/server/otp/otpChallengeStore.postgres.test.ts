/**
 * Postgres-backed pin for the review-email supersede.
 *
 * `createSupersedingAgentOtpChallenge` is the only challenge writer that
 * invalidates rows it did not create, and its SQL depends on the `auth_service`
 * grant set and on the `otp_challenges_transport_csrf_check` constraint, so only
 * a real database proves it leaves exactly one live agent challenge for the
 * email, resolvable through the handle it returned, and touches nothing else.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { hashOpaqueToken } from "../crockford.js";
import { getPool, query } from "../db.js";
import { createSupersedingAgentOtpChallenge, lookupAgentOtpChallenge } from "./otpChallengeStore.js";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const authDatabaseUrl = process.env.AUTH_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || authDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and AUTH_DATABASE_URL are required for the Postgres-backed OTP supersede test";
// CI has to prove the supersede SQL runs as the shipped role, so missing wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const readBooleanColumn = (row: unknown, key: string): boolean => {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`OTP supersede check: database returned an invalid row for ${key}`);
  }
  const value = (row as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "boolean") {
    throw new Error(`OTP supersede check: database column ${key} must be a boolean`);
  }
  return value;
};

test(
  "the real supersede keeps one live agent challenge for the review email and leaves every other row alone",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const suffix = randomUUID().replaceAll("-", "");
    const reviewEmail = `supersede-review-${suffix}@example.com`;
    const otherEmail = `supersede-other-${suffix}@example.com`;
    const demoSession = `demo-agent:${reviewEmail}`;
    const priorAgentHash = hashOpaqueToken(`prior-agent-${suffix}`);
    const otherEmailAgentHash = hashOpaqueToken(`other-email-agent-${suffix}`);
    const browserHash = hashOpaqueToken(`browser-${suffix}`);
    const alreadyUsedAgentHash = hashOpaqueToken(`already-used-agent-${suffix}`);
    const nowMs = Date.now();
    const alreadyUsedAt = new Date(nowMs - 30_000);
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });

    try {
      await ownerPool.query(
        `INSERT INTO auth.otp_challenges
           (challenge_id_hash, transport, normalized_email, cognito_session, csrf_token, created_at, expires_at, used_at, failed_attempts)
         VALUES
           ($1, 'agent', $5, 'cognito-session-prior', NULL, $9, $10, NULL, 0),
           ($2, 'agent', $6, 'cognito-session-other', NULL, $9, $10, NULL, 0),
           ($3, 'browser', $5, 'cognito-session-browser', $7, $9, $10, NULL, 0),
           ($4, 'agent', $5, 'cognito-session-used', NULL, $9, $10, $8, 0)`,
        [
          priorAgentHash,
          otherEmailAgentHash,
          browserHash,
          alreadyUsedAgentHash,
          reviewEmail,
          otherEmail,
          `csrf-${suffix}`,
          alreadyUsedAt,
          new Date(nowMs - 60_000),
          new Date(nowMs + 120_000),
        ],
      );

      const roleResult = await query("SELECT current_user = 'auth_service' AS is_auth_service", []);
      assert.equal(readBooleanColumn(roleResult.rows[0], "is_auth_service"), true);

      const firstHandle = await createSupersedingAgentOtpChallenge(reviewEmail, demoSession, nowMs);
      const secondHandle = await createSupersedingAgentOtpChallenge(reviewEmail, demoSession, nowMs);
      assert.notEqual(firstHandle, secondHandle);

      // The handle the send returned is what verify-code has to resolve.
      assert.deepEqual(
        await lookupAgentOtpChallenge(secondHandle, nowMs),
        { status: "active", email: reviewEmail, cognitoSession: demoSession },
      );
      assert.deepEqual(await lookupAgentOtpChallenge(firstHandle, nowMs), { status: "used", email: reviewEmail });

      const rowCheck = await ownerPool.query(
        `SELECT
           (SELECT count(*) FROM auth.otp_challenges
            WHERE transport = 'agent' AND normalized_email = $1 AND used_at IS NULL) = 1 AS single_live_agent_row,
           EXISTS (SELECT 1 FROM auth.otp_challenges
                   WHERE challenge_id_hash = $2 AND transport = 'agent' AND csrf_token IS NULL
                   AND used_at IS NULL AND expires_at > $8) AS issued_row_live,
           EXISTS (SELECT 1 FROM auth.otp_challenges
                   WHERE challenge_id_hash = $3 AND used_at IS NOT NULL) AS prior_agent_row_superseded,
           EXISTS (SELECT 1 FROM auth.otp_challenges
                   WHERE challenge_id_hash = $4 AND used_at IS NULL) AS other_email_row_untouched,
           EXISTS (SELECT 1 FROM auth.otp_challenges
                   WHERE challenge_id_hash = $5 AND used_at IS NULL) AS browser_row_untouched,
           EXISTS (SELECT 1 FROM auth.otp_challenges
                   WHERE challenge_id_hash = $6 AND used_at = $7) AS already_used_row_untouched`,
        [
          reviewEmail,
          hashOpaqueToken(secondHandle),
          priorAgentHash,
          otherEmailAgentHash,
          browserHash,
          alreadyUsedAgentHash,
          alreadyUsedAt,
          new Date(nowMs),
        ],
      );
      const row = rowCheck.rows[0];
      assert.equal(readBooleanColumn(row, "single_live_agent_row"), true);
      assert.equal(readBooleanColumn(row, "issued_row_live"), true);
      assert.equal(readBooleanColumn(row, "prior_agent_row_superseded"), true);
      assert.equal(readBooleanColumn(row, "other_email_row_untouched"), true);
      assert.equal(readBooleanColumn(row, "browser_row_untouched"), true);
      assert.equal(readBooleanColumn(row, "already_used_row_untouched"), true);
    } finally {
      try {
        await ownerPool.query("DELETE FROM auth.otp_challenges WHERE normalized_email = ANY($1)", [
          [reviewEmail, otherEmail],
        ]);
      } finally {
        await Promise.all([ownerPool.end(), getPool().end()]);
      }
    }
  },
);
