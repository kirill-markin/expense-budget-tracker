import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

type AgentRole = "api_sql_reader" | "api_sql_executor";

type AdjustmentRow = Readonly<{
  adjustment_id: string;
  workspace_id: string;
  budget_month: string;
  direction: "income" | "spend";
  category: string;
  amount: string;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}>;

type SeededAdjustment = Readonly<{
  origin: "user" | "legacy";
  row: AdjustmentRow;
}>;

type IsolationFixture = Readonly<{
  userA: string;
  userB: string;
  userC: string;
  // Member of both workspaces, so only the selected workspace can limit what this user reads.
  userD: string;
  workspaceA: string;
  workspaceB: string;
  adjustments: ReadonlyArray<SeededAdjustment>;
}>;

type AgentContext = Readonly<{
  role: AgentRole;
  userId: string | null;
  workspaceId: string | null;
}>;

type VisibilityCase = Readonly<{
  label: string;
  userId: string | null;
  workspaceId: string | null;
  sql: string;
  params: ReadonlyArray<string>;
  expectedRows: ReadonlyArray<AdjustmentRow>;
}>;

type PgError = Error & Readonly<{
  code?: string;
}>;

const AGENT_ROLES: ReadonlyArray<AgentRole> = ["api_sql_reader", "api_sql_executor"];

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const appDatabaseUrl = process.env.APP_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || appDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and APP_DATABASE_URL are required for the Postgres-backed budget_adjustments isolation test";
// CI has to prove isolation, so missing database wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const ADJUSTMENT_COLUMNS = `adjustment_id, workspace_id, budget_month::text AS budget_month, direction, category,
  amount::text AS amount, note, created_at, updated_at`;
const READ_ADJUSTMENTS_SQL = `SELECT ${ADJUSTMENT_COLUMNS} FROM budget_adjustments ORDER BY adjustment_id`;
const READ_WORKSPACE_ADJUSTMENTS_SQL =
  `SELECT ${ADJUSTMENT_COLUMNS} FROM budget_adjustments WHERE workspace_id = $1 ORDER BY adjustment_id`;
const PERMISSION_DENIED = {
  code: "42501",
  message: "permission denied for table budget_adjustments",
} as const;
const ROW_LEVEL_SECURITY_VIOLATION = {
  code: "42501",
  message: 'new row violates row-level security policy for table "budget_adjustments"',
} as const;

const createFixture = (): IsolationFixture => {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceA = `adjustments-isolation-workspace-a-${suffix}`;
  const workspaceB = `adjustments-isolation-workspace-b-${suffix}`;
  const createdAt = new Date("2026-03-02T08:00:00.000Z");
  const updatedAt = new Date("2026-03-05T09:30:00.000Z");
  const adjustment = (
    index: number,
    origin: SeededAdjustment["origin"],
    workspaceId: string,
    budgetMonth: string,
    direction: AdjustmentRow["direction"],
    category: string,
    amount: string,
    note: string | null,
  ): SeededAdjustment => ({
    origin,
    row: {
      adjustment_id: `adjustment-${suffix}-${String(index)}`,
      workspace_id: workspaceId,
      budget_month: budgetMonth,
      direction,
      category,
      amount,
      note,
      created_at: createdAt,
      updated_at: updatedAt,
    },
  });

  return {
    userA: `adjustments-isolation-user-a-${suffix}`,
    userB: `adjustments-isolation-user-b-${suffix}`,
    userC: `adjustments-isolation-user-c-${suffix}`,
    userD: `adjustments-isolation-user-d-${suffix}`,
    workspaceA,
    workspaceB,
    adjustments: [
      adjustment(1, "user", workspaceA, "2026-03-01", "spend", "Groceries", "150", "Guests in March"),
      adjustment(2, "user", workspaceA, "2026-03-01", "spend", "Groceries", "-40", null),
      adjustment(3, "legacy", workspaceA, "2026-04-01", "income", "Salary", "300", "Imported modifier"),
      adjustment(4, "user", workspaceB, "2026-03-01", "spend", "Groceries", "999", "Other workspace"),
      adjustment(5, "user", workspaceB, "2026-03-01", "income", "Consulting", "25", null),
    ],
  };
};

const rowsOfWorkspace = (
  fixture: IsolationFixture,
  workspaceId: string,
): ReadonlyArray<AdjustmentRow> =>
  fixture.adjustments
    .map((seeded) => seeded.row)
    .filter((row) => row.workspace_id === workspaceId);

const runOwnerTransaction = async (
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<void>,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await callback(client);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const insertFixture = async (pool: pg.Pool, fixture: IsolationFixture): Promise<void> =>
  runOwnerTransaction(pool, async (client): Promise<void> => {
    for (const userId of [fixture.userA, fixture.userB, fixture.userC, fixture.userD]) {
      await client.query(
        `INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled)
         VALUES ($1, $2, true, 'CONFIRMED', true)`,
        [userId, `${userId}@example.invalid`],
      );
    }
    for (const workspaceId of [fixture.workspaceA, fixture.workspaceB]) {
      await client.query(
        "INSERT INTO public.workspaces (workspace_id, name) VALUES ($1, $2)",
        [workspaceId, "budget_adjustments isolation test"],
      );
    }
    const memberships: ReadonlyArray<readonly [workspaceId: string, userId: string]> = [
      [fixture.workspaceA, fixture.userA],
      [fixture.workspaceA, fixture.userC],
      [fixture.workspaceA, fixture.userD],
      [fixture.workspaceB, fixture.userB],
      [fixture.workspaceB, fixture.userD],
    ];
    for (const [workspaceId, userId] of memberships) {
      await client.query(
        "INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)",
        [workspaceId, userId],
      );
    }
    for (const { origin, row } of fixture.adjustments) {
      await client.query(
        `INSERT INTO public.budget_adjustments
           (adjustment_id, workspace_id, budget_month, direction, category, amount, note, origin, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.adjustment_id,
          row.workspace_id,
          row.budget_month,
          row.direction,
          row.category,
          row.amount,
          row.note,
          origin,
          row.created_at,
          row.updated_at,
        ],
      );
    }
  });

const deleteFixture = async (pool: pg.Pool, fixture: IsolationFixture): Promise<void> =>
  runOwnerTransaction(pool, async (client): Promise<void> => {
    const workspaceIds: ReadonlyArray<string> = [fixture.workspaceA, fixture.workspaceB];
    await client.query("DELETE FROM public.budget_adjustments WHERE workspace_id = ANY($1::TEXT[])", [workspaceIds]);
    await client.query("DELETE FROM public.workspace_members WHERE workspace_id = ANY($1::TEXT[])", [workspaceIds]);
    await client.query("DELETE FROM public.workspaces WHERE workspace_id = ANY($1::TEXT[])", [workspaceIds]);
    await client.query(
      "DELETE FROM public.users WHERE user_id = ANY($1::TEXT[])",
      [[fixture.userA, fixture.userB, fixture.userC, fixture.userD]],
    );
  });

/**
 * Mirrors the runtime agent context: app sets app.user_id and app.workspace_id
 * for the transaction, then SET LOCAL ROLE narrows it. Each case opens its own
 * connection so no earlier case's session state reaches it and an unset app.*
 * setting reads back as NULL. Plain BEGIN, not the read path's READ ONLY
 * transaction, lets a write attempt reach the privilege check.
 */
const withAgentTransaction = async <T>(
  context: AgentContext,
  callback: (client: pg.Client) => Promise<T>,
): Promise<T> => {
  const client = new pg.Client({ connectionString: appDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (context.userId !== null) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
    }
    if (context.workspaceId !== null) {
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [context.workspaceId]);
    }
    await client.query(`SET LOCAL ROLE ${context.role}`);
    const session = await client.query(
      `SELECT session_user AS session_role,
              current_user AS effective_role,
              current_setting('app.user_id', true) AS user_id,
              current_setting('app.workspace_id', true) AS workspace_id`,
    );
    assert.deepEqual(session.rows, [{
      session_role: "app",
      effective_role: context.role,
      user_id: context.userId,
      workspace_id: context.workspaceId,
    }]);
    return await callback(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
};

const assertVisibleRows = async (
  role: AgentRole,
  visibilityCase: VisibilityCase,
): Promise<void> => {
  const rows: ReadonlyArray<unknown> = await withAgentTransaction(
    { role, userId: visibilityCase.userId, workspaceId: visibilityCase.workspaceId },
    async (client): Promise<ReadonlyArray<unknown>> =>
      (await client.query(visibilityCase.sql, Array.from(visibilityCase.params))).rows,
  );
  assert.deepEqual(rows, visibilityCase.expectedRows, `${role}: ${visibilityCase.label}`);
};

const assertPermissionDenied = async (
  context: AgentContext,
  sql: string,
  params: ReadonlyArray<string>,
): Promise<void> => {
  await assert.rejects(
    withAgentTransaction(context, async (client): Promise<void> => {
      await client.query(sql, Array.from(params));
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error, `${context.role}: ${sql} must fail with a PostgreSQL error`);
      assert.deepEqual(
        { code: (error as PgError).code, message: error.message },
        PERMISSION_DENIED,
        `${context.role}: ${sql}`,
      );
      return true;
    },
  );
};

const assertRowLevelSecurityViolation = async (
  context: AgentContext,
  sql: string,
  params: ReadonlyArray<string>,
): Promise<void> => {
  await assert.rejects(
    withAgentTransaction(context, async (client): Promise<void> => {
      await client.query(sql, Array.from(params));
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error, `${context.role}: ${sql} must fail with a PostgreSQL error`);
      assert.deepEqual(
        { code: (error as PgError).code, message: error.message },
        ROW_LEVEL_SECURITY_VIOLATION,
        `${context.role}: ${sql}`,
      );
      return true;
    },
  );
};

const assertNoRowsAffected = async (
  context: AgentContext,
  label: string,
  sql: string,
  params: ReadonlyArray<string>,
): Promise<void> => {
  const rowCount: number | null = await withAgentTransaction(
    context,
    async (client): Promise<number | null> => (await client.query(sql, Array.from(params))).rowCount,
  );
  assert.equal(rowCount, 0, `${context.role}: ${label}`);
};

for (const role of AGENT_ROLES) {
  test(
    `${role} reads budget_adjustments only for a selected workspace the user belongs to and never reaches the internal origin column`,
    { skip: postgresTestSkip },
    async (): Promise<void> => {
      if (databaseUrlsMissing) {
        throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
      }

      const fixture = createFixture();
      const workspaceARows = rowsOfWorkspace(fixture, fixture.workspaceA);
      const workspaceBRows = rowsOfWorkspace(fixture, fixture.workspaceB);
      const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });

      try {
        await insertFixture(ownerPool, fixture);

        const visibilityCases: ReadonlyArray<VisibilityCase> = [
          {
            label: "member A with workspace A sees exactly workspace A's rows",
            userId: fixture.userA,
            workspaceId: fixture.workspaceA,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: workspaceARows,
          },
          {
            label: "member C shares workspace A and sees the same rows",
            userId: fixture.userC,
            workspaceId: fixture.workspaceA,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: workspaceARows,
          },
          {
            label: "member A with workspace A filtering on workspace B's id sees nothing",
            userId: fixture.userA,
            workspaceId: fixture.workspaceA,
            sql: READ_WORKSPACE_ADJUSTMENTS_SQL,
            params: [fixture.workspaceB],
            expectedRows: [],
          },
          {
            label: "user A selecting workspace B without membership sees nothing",
            userId: fixture.userA,
            workspaceId: fixture.workspaceB,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: [],
          },
          {
            label: "member B with workspace B sees only workspace B's rows",
            userId: fixture.userB,
            workspaceId: fixture.workspaceB,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: workspaceBRows,
          },
          {
            label: "user B selecting workspace A without membership sees nothing",
            userId: fixture.userB,
            workspaceId: fixture.workspaceA,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: [],
          },
          {
            label: "member D of both workspaces with workspace A sees exactly workspace A's rows",
            userId: fixture.userD,
            workspaceId: fixture.workspaceA,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: workspaceARows,
          },
          {
            label: "member D of both workspaces with workspace A filtering on workspace B's id sees nothing",
            userId: fixture.userD,
            workspaceId: fixture.workspaceA,
            sql: READ_WORKSPACE_ADJUSTMENTS_SQL,
            params: [fixture.workspaceB],
            expectedRows: [],
          },
          {
            label: "member D of both workspaces with workspace B sees exactly workspace B's rows",
            userId: fixture.userD,
            workspaceId: fixture.workspaceB,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: workspaceBRows,
          },
          {
            label: "unset app.user_id sees nothing",
            userId: null,
            workspaceId: fixture.workspaceA,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: [],
          },
          {
            label: "unset app.workspace_id sees nothing",
            userId: fixture.userA,
            workspaceId: null,
            sql: READ_ADJUSTMENTS_SQL,
            params: [],
            expectedRows: [],
          },
        ];
        for (const visibilityCase of visibilityCases) {
          await assertVisibleRows(role, visibilityCase);
        }

        await ownerPool.query(
          "DELETE FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2",
          [fixture.workspaceA, fixture.userA],
        );
        await assertVisibleRows(role, {
          label: "user A removed from workspace A sees nothing",
          userId: fixture.userA,
          workspaceId: fixture.workspaceA,
          sql: READ_ADJUSTMENTS_SQL,
          params: [],
          expectedRows: [],
        });
        await assertVisibleRows(role, {
          label: "member C still sees workspace A's rows after A's removal",
          userId: fixture.userC,
          workspaceId: fixture.workspaceA,
          sql: READ_ADJUSTMENTS_SQL,
          params: [],
          expectedRows: workspaceARows,
        });
        await ownerPool.query(
          "INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)",
          [fixture.workspaceA, fixture.userA],
        );
        await assertVisibleRows(role, {
          label: "user A restored to workspace A sees its rows again",
          userId: fixture.userA,
          workspaceId: fixture.workspaceA,
          sql: READ_ADJUSTMENTS_SQL,
          params: [],
          expectedRows: workspaceARows,
        });

        const memberContext: AgentContext = {
          role,
          userId: fixture.userA,
          workspaceId: fixture.workspaceA,
        };
        const workspaceAAdjustmentId = workspaceARows[0]?.adjustment_id;
        assert.ok(workspaceAAdjustmentId !== undefined, "fixture must seed a workspace A adjustment");
        // The internal origin marker stays outside every grant of both roles.
        await assertPermissionDenied(
          memberContext,
          "SELECT origin FROM budget_adjustments WHERE adjustment_id = $1",
          [workspaceAAdjustmentId],
        );
        await assertPermissionDenied(memberContext, "SELECT * FROM budget_adjustments", []);
        await assertPermissionDenied(
          memberContext,
          `INSERT INTO budget_adjustments (workspace_id, budget_month, direction, category, amount, origin)
           VALUES ($1, '2026-03-01', 'spend', 'Groceries', 5, 'legacy')`,
          [fixture.workspaceA],
        );
        await assertPermissionDenied(
          memberContext,
          "UPDATE budget_adjustments SET origin = 'legacy' WHERE adjustment_id = $1",
          [workspaceAAdjustmentId],
        );

        if (role === "api_sql_reader") {
          // The reader role holds a column-level SELECT and no write grant at all.
          await assertPermissionDenied(
            memberContext,
            `INSERT INTO budget_adjustments (workspace_id, budget_month, direction, category, amount)
             VALUES ($1, '2026-03-01', 'spend', 'Groceries', 5)`,
            [fixture.workspaceA],
          );
          await assertPermissionDenied(
            memberContext,
            "UPDATE budget_adjustments SET amount = 5 WHERE adjustment_id = $1",
            [workspaceAAdjustmentId],
          );
          await assertPermissionDenied(
            memberContext,
            "DELETE FROM budget_adjustments WHERE adjustment_id = $1",
            [workspaceAAdjustmentId],
          );
        }

        const storedRows = await ownerPool.query(
          `SELECT ${ADJUSTMENT_COLUMNS}, origin
           FROM public.budget_adjustments
           WHERE workspace_id = ANY($1::TEXT[])
           ORDER BY adjustment_id`,
          [[fixture.workspaceA, fixture.workspaceB]],
        );
        assert.deepEqual(
          storedRows.rows,
          fixture.adjustments.map(({ origin, row }) => ({ ...row, origin })),
          `${role}: seeded adjustments must be unchanged after the denied statements`,
        );
      } finally {
        try {
          await deleteFixture(ownerPool, fixture);
        } finally {
          await ownerPool.end();
        }
      }
    },
  );
}

test(
  "api_sql_executor writes budget_adjustments of the selected workspace only, legacy-origin rows included",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const fixture = createFixture();
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });

    try {
      await insertFixture(ownerPool, fixture);

      const userRow = fixture.adjustments
        .find((seeded) => seeded.origin === "user" && seeded.row.workspace_id === fixture.workspaceA)
        ?.row;
      const legacyRow = fixture.adjustments
        .find((seeded) => seeded.origin === "legacy" && seeded.row.workspace_id === fixture.workspaceA)
        ?.row;
      const otherWorkspaceRow = fixture.adjustments
        .find((seeded) => seeded.row.workspace_id === fixture.workspaceB)
        ?.row;
      assert.ok(userRow !== undefined, "fixture must seed a user-origin workspace A adjustment");
      assert.ok(legacyRow !== undefined, "fixture must seed a legacy-origin workspace A adjustment");
      assert.ok(otherWorkspaceRow !== undefined, "fixture must seed a workspace B adjustment");

      // Every case rolls its transaction back, so the seeded rows below still
      // prove the denied writes changed nothing.
      const selectedWorkspace: AgentContext = {
        role: "api_sql_executor",
        userId: fixture.userA,
        workspaceId: fixture.workspaceA,
      };

      await withAgentTransaction(selectedWorkspace, async (client): Promise<void> => {
        const inserted = await client.query(
          `INSERT INTO budget_adjustments (workspace_id, budget_month, direction, category, amount, note)
           VALUES ($1, '2026-03-01', 'spend', 'Groceries', 5, 'Agent write')
           RETURNING workspace_id, budget_month::text AS budget_month, direction, category,
             amount::text AS amount, note`,
          [fixture.workspaceA],
        );
        assert.deepEqual(inserted.rows, [{
          workspace_id: fixture.workspaceA,
          budget_month: "2026-03-01",
          direction: "spend",
          category: "Groceries",
          amount: "5",
          note: "Agent write",
        }]);
      });

      await withAgentTransaction(selectedWorkspace, async (client): Promise<void> => {
        const updated = await client.query(
          `UPDATE budget_adjustments SET category = 'Groceries and household', amount = 7
           WHERE adjustment_id = $1
           RETURNING adjustment_id, category, amount::text AS amount`,
          [userRow.adjustment_id],
        );
        assert.deepEqual(updated.rows, [{
          adjustment_id: userRow.adjustment_id,
          category: "Groceries and household",
          amount: "7",
        }]);
      });

      // A legacy-origin row is an ordinary row: the transitional freeze is gone.
      await withAgentTransaction(selectedWorkspace, async (client): Promise<void> => {
        const renamed = await client.query(
          "UPDATE budget_adjustments SET category = 'Base salary' WHERE adjustment_id = $1 RETURNING adjustment_id",
          [legacyRow.adjustment_id],
        );
        assert.deepEqual(renamed.rows, [{ adjustment_id: legacyRow.adjustment_id }]);

        const deleted = await client.query(
          "DELETE FROM budget_adjustments WHERE adjustment_id = $1 RETURNING adjustment_id",
          [legacyRow.adjustment_id],
        );
        assert.deepEqual(deleted.rows, [{ adjustment_id: legacyRow.adjustment_id }]);
      });

      // workspace_id carries no UPDATE grant, so no statement can re-home a
      // visible row into another workspace.
      await assertPermissionDenied(
        selectedWorkspace,
        "UPDATE budget_adjustments SET workspace_id = $2 WHERE adjustment_id = $1",
        [userRow.adjustment_id, fixture.workspaceB],
      );

      const insertSql =
        `INSERT INTO budget_adjustments (workspace_id, budget_month, direction, category, amount)
         VALUES ($1, '2026-03-01', 'spend', 'Groceries', 5)`;
      // Only the policies decide which workspace a row may belong to.
      await assertRowLevelSecurityViolation(selectedWorkspace, insertSql, [fixture.workspaceB]);
      await assertRowLevelSecurityViolation(
        { role: "api_sql_executor", userId: fixture.userA, workspaceId: fixture.workspaceB },
        insertSql,
        [fixture.workspaceB],
      );
      await assertRowLevelSecurityViolation(
        { role: "api_sql_executor", userId: fixture.userA, workspaceId: null },
        insertSql,
        [fixture.workspaceA],
      );
      await assertRowLevelSecurityViolation(
        { role: "api_sql_executor", userId: null, workspaceId: fixture.workspaceA },
        insertSql,
        [fixture.workspaceA],
      );

      const updateSql = "UPDATE budget_adjustments SET amount = 5 WHERE adjustment_id = $1";
      const deleteSql = "DELETE FROM budget_adjustments WHERE adjustment_id = $1";
      const invisibleWriteCases: ReadonlyArray<Readonly<{
        label: string;
        context: AgentContext;
        adjustmentId: string;
      }>> = [
        {
          label: "workspace B's row stays invisible while workspace A is selected",
          context: selectedWorkspace,
          adjustmentId: otherWorkspaceRow.adjustment_id,
        },
        {
          label: "selecting workspace B without membership sees none of its rows",
          context: { role: "api_sql_executor", userId: fixture.userA, workspaceId: fixture.workspaceB },
          adjustmentId: otherWorkspaceRow.adjustment_id,
        },
        {
          label: "unset app.workspace_id sees no row to change",
          context: { role: "api_sql_executor", userId: fixture.userA, workspaceId: null },
          adjustmentId: userRow.adjustment_id,
        },
        {
          label: "unset app.user_id sees no row to change",
          context: { role: "api_sql_executor", userId: null, workspaceId: fixture.workspaceA },
          adjustmentId: userRow.adjustment_id,
        },
      ];
      for (const { label, context, adjustmentId } of invisibleWriteCases) {
        await assertNoRowsAffected(context, `UPDATE: ${label}`, updateSql, [adjustmentId]);
        await assertNoRowsAffected(context, `DELETE: ${label}`, deleteSql, [adjustmentId]);
      }

      const storedRows = await ownerPool.query(
        `SELECT ${ADJUSTMENT_COLUMNS}, origin
         FROM public.budget_adjustments
         WHERE workspace_id = ANY($1::TEXT[])
         ORDER BY adjustment_id`,
        [[fixture.workspaceA, fixture.workspaceB]],
      );
      assert.deepEqual(
        storedRows.rows,
        fixture.adjustments.map(({ origin, row }) => ({ ...row, origin })),
        "seeded adjustments must be unchanged after every rolled-back and rejected write",
      );
    } finally {
      try {
        await deleteFixture(ownerPool, fixture);
      } finally {
        await ownerPool.end();
      }
    }
  },
);
