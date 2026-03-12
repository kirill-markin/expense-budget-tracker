/**
 * Execute API route logic with consistent error mapping and structured logging.
 *
 * Validation failures are returned as-is. Unexpected failures are logged through
 * the server logger and mapped to the route's configured internal error response.
 */
import { ApiRouteError, toErrorResponse } from "@/server/api/errors";
import { log } from "@/server/logger";

type RouteContext = Readonly<{
  route: string;
  method: string;
  internalErrorMessage: string;
}>;

/**
 * Run an API route action and translate route errors or unexpected failures
 * into a plain Response.
 */
export const handleRoute = async (
  context: RouteContext,
  run: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiRouteError) {
      return toErrorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "api", action: "error", route: context.route, method: context.method, error: message });
    return new Response(context.internalErrorMessage, { status: 500 });
  }
};
