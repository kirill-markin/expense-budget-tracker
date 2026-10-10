/**
 * Wiring for `/api/chat/files`. Demo-mode detection is bound here, so the
 * handler module itself needs no Next.js request-scoped import.
 */
import { isDemoModeFromRequest } from "@/lib/demoMode";
import {
  buildChatFilesRouteDependencies,
  getChatFilesRouteWithDeps,
  postChatFilesRouteWithDeps,
} from "@/server/chat/http/filesRoute";

const DEPENDENCIES = buildChatFilesRouteDependencies(isDemoModeFromRequest);

export const POST = async (request: Request): Promise<Response> =>
  postChatFilesRouteWithDeps(request, DEPENDENCIES);

export const GET = async (request: Request): Promise<Response> =>
  getChatFilesRouteWithDeps(request, DEPENDENCIES);
