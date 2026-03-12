import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { upsertAccountMetadata } from "@/server/balances/upsertAccountMetadata";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const accountMetadataBodySchema = z.object({
  accountId: z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      ctx.addIssue({ code: "custom", message: "Invalid accountId. Expected non-empty string (max 200 chars)" });
    }
  }).transform((value): string => value as string),
  liquidity: z.unknown().superRefine((value, ctx) => {
    if (value !== "high" && value !== "medium" && value !== "low") {
      ctx.addIssue({ code: "custom", message: "Invalid liquidity. Expected one of: high, medium, low" });
    }
  }).transform((value): string => value as string),
});

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/account-metadata", method: "POST", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = await parseJsonBody(request, accountMetadataBodySchema);

      if (isDemoModeFromRequest(request)) {
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      await upsertAccountMetadata(userId, workspaceId, body);
      return Response.json({ ok: true });
    },
  );
