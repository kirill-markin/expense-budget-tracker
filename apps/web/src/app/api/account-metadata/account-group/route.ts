import { ACCOUNT_METADATA_GROUP_VALUES } from "@expense-budget-tracker/agent-shared";
import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { upsertAccountGroup } from "@/server/balances/upsertAccountMetadata";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const accountGroupBodySchema = z.object({
  accountId: z.string().min(1).max(200),
  accountGroup: z.enum(ACCOUNT_METADATA_GROUP_VALUES),
});

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/account-metadata/account-group", method: "POST", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = await parseJsonBody(request, accountGroupBodySchema);

      if (isDemoModeFromRequest(request)) {
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      await upsertAccountGroup(userId, workspaceId, body);
      return Response.json({ ok: true });
    },
  );
