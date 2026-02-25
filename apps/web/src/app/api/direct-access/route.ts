/**
 * Direct database access credential management (show-once model).
 *
 * GET    — check if provisioned; returns credentials WITHOUT password
 * POST   — provision new credentials; returns password (one-time only)
 * DELETE — revoke credentials and drop the Postgres role
 * PUT    — rotate password; returns new password (one-time only)
 *
 * Passwords are never stored — Postgres handles auth internally (pg_authid).
 * The password is visible only in the POST/PUT response body; GET always
 * returns password: null.
 *
 * Authorization: userId/workspaceId come from headers set by middleware (ALB +
 * Cognito in prod, local defaults in dev). Workspace membership is enforced
 * by the SECURITY DEFINER SQL functions.
 */
import { isDemoModeFromRequest } from "@/lib/demoMode";
import {
  getDirectAccessCredentials,
  provisionDirectAccess,
  revokeDirectAccess,
  rotateDirectAccessPassword,
} from "@/server/directAccess";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("Direct access is not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const credentials = await getDirectAccessCredentials(userId, workspaceId);
    return Response.json({ credentials });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database query failed: ${message}`, { status: 500 });
  }
};

export const POST = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("Direct access is not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const credentials = await provisionDirectAccess(userId, workspaceId);
    return Response.json({ credentials });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Provisioning failed: ${message}`, { status: 500 });
  }
};

export const DELETE = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("Direct access is not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    await revokeDirectAccess(userId, workspaceId);
    return Response.json({ revoked: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Revocation failed: ${message}`, { status: 500 });
  }
};

export const PUT = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return new Response("Direct access is not available in demo mode", { status: 404 });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const credentials = await rotateDirectAccessPassword(userId, workspaceId);
    return Response.json({ credentials });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Password rotation failed: ${message}`, { status: 500 });
  }
};
