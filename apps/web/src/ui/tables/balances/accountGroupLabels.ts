import type { AccountMetadataGroup } from "@expense-budget-tracker/agent-shared";

export const ACCOUNT_GROUP_LABEL_KEYS: Readonly<Record<AccountMetadataGroup, string>> = {
  regular: "balances.accountGroupRegular",
  investment: "balances.accountGroupInvestment",
};
