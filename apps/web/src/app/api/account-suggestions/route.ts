import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getAccountSuggestions } from "@/server/accounts/getAccountSuggestions";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { getDemoAccountSuggestions } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type AccountSuggestionsRouteDependencies = Readonly<{
  getAccountSuggestions: typeof getAccountSuggestions;
  getDemoAccountSuggestions: typeof getDemoAccountSuggestions;
}>;

const DEFAULT_ACCOUNT_SUGGESTIONS_ROUTE_DEPENDENCIES: AccountSuggestionsRouteDependencies = {
  getAccountSuggestions,
  getDemoAccountSuggestions,
};

export const dynamic = "force-dynamic";

export const getAccountSuggestionsRouteWithDeps = async (
  request: Request,
  dependencies: AccountSuggestionsRouteDependencies,
): Promise<Response> =>
  handleRoute(
    {
      route: "/api/account-suggestions",
      method: "GET",
      internalErrorMessage: "Database query failed",
    },
    async (): Promise<Response> => {
      if (isDemoModeFromRequest(request)) {
        return jsonNoStore(dependencies.getDemoAccountSuggestions());
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const suggestions = await dependencies.getAccountSuggestions(userId, workspaceId);
      return jsonNoStore(suggestions);
    },
  );

export const GET = async (request: Request): Promise<Response> =>
  getAccountSuggestionsRouteWithDeps(request, DEFAULT_ACCOUNT_SUGGESTIONS_ROUTE_DEPENDENCIES);
