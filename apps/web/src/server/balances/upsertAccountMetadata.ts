import { queryAs } from "@/server/db";

type UpsertParams = Readonly<{
  accountId: string;
  liquidity: string;
}>;

export const upsertAccountMetadata = async (
  userId: string,
  workspaceId: string,
  params: UpsertParams,
): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    `INSERT INTO account_metadata (workspace_id, account_id, liquidity)
     VALUES (current_setting('app.workspace_id', true), $1, $2)
     ON CONFLICT (workspace_id, account_id)
     DO UPDATE SET liquidity = EXCLUDED.liquidity`,
    [params.accountId, params.liquidity],
  );
};
