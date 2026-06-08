import type {
  AccountMetadataAccountType,
  AccountMetadataGroup,
  AccountMetadataLiquidity,
} from "@expense-budget-tracker/agent-shared";

import { queryAs } from "@/server/db";

type UpsertParams = Readonly<{
  accountId: string;
  liquidity: AccountMetadataLiquidity;
  accountType: AccountMetadataAccountType;
}>;

type UpsertAccountGroupParams = Readonly<{
  accountId: string;
  accountGroup: AccountMetadataGroup;
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

export const upsertAccountGroup = async (
  userId: string,
  workspaceId: string,
  params: UpsertAccountGroupParams,
): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    `INSERT INTO account_metadata (workspace_id, account_id, account_group)
     VALUES (current_setting('app.workspace_id', true), $1, $2)
     ON CONFLICT (workspace_id, account_id)
     DO UPDATE SET account_group = EXCLUDED.account_group`,
    [params.accountId, params.accountGroup],
  );
};
