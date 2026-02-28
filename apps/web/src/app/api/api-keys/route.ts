/**
 * API key management endpoints (JWT-authenticated, same pattern as direct-access).
 *
 * GET    — list keys for the current user in the active workspace
 * POST   — create a new key; returns the full key (show-once)
 * DELETE — revoke a key by ID
 */
import { isDemoModeFromRequest } from "@/lib/demoMode";
import { createApiKey, listApiKeys, revokeApiKey } from "@/server/apiKeys";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const logAndRespond = (label: string, error: unknown): Response => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("api-keys %s: %s", label, message);
  return new Response("Operation failed", { status: 500 });
};

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("API keys are not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const keys = await listApiKeys(userId, workspaceId);
    return Response.json({ keys });
  } catch (error) {
    return logAndRespond("GET", error);
  }
};

export const POST = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("API keys are not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  let label = "";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.label === "string") {
      label = body.label.slice(0, 200);
    }
  } catch {
    // No body or invalid JSON — label defaults to empty string.
  }

  try {
    const result = await createApiKey(userId, workspaceId, label);
    return Response.json(result);
  } catch (error) {
    return logAndRespond("POST", error);
  }
};

export const DELETE = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("API keys are not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  let id: string;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.id !== "string" || body.id === "") {
      return new Response("Missing key id", { status: 400 });
    }
    id = body.id;
  } catch {
    return new Response("Invalid request body", { status: 400 });
  }

  try {
    await revokeApiKey(userId, workspaceId, id);
    return Response.json({ revoked: true });
  } catch (error) {
    return logAndRespond("DELETE", error);
  }
};
