import { queryAs } from "@/server/db";

type UpsertParams = Readonly<{
  accountId: string;
  liquidity: string;
  accountType: string;
}>;

export const upsertAccountMetadata = async (
  userId: string,
  workspaceId: string,
  params: UpsertParams,
): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    `INSERT INTO account_metadata (workspace_id, account_id, liquidity, account_type)
     VALUES (current_setting('app.workspace_id', true), $1, $2, $3)
     ON CONFLICT (workspace_id, account_id)
     DO UPDATE SET liquidity = EXCLUDED.liquidity,
                   account_type = EXCLUDED.account_type`,
    [params.accountId, params.liquidity, params.accountType],
  );
};
