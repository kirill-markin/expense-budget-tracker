/**
 * Human settings API for listing and creating agent connections.
 *
 * Creation is served in AUTH_MODE=proxy_jwt only. There the upstream proxy has
 * already authenticated the person making this request, so the browser session
 * is proof enough to mint a key. AUTH_MODE=cognito keeps the email OTP flow on
 * the auth service as its only issuing path, because that code is a real
 * second factor at the moment a long-lived credential is created.
 *
 * The mode read here is this container's own AUTH_MODE, and it decides only
 * this route. Whether the OTP issuer exists is decided separately by the auth
 * container's own AUTH_MODE, which `apps/auth/src/server/authMode.ts` reads as
 * cognito when unset or blank; `getAuthRoutes` registers the OTP routes in
 * cognito and omits them in proxy_jwt. The premise of this route — that it is
 * the only issuing path in a proxy_jwt deployment — therefore holds only when
 * the auth service does not serve the OTP routes. An auth container left at
 * its default serves them only if it is also given a working Cognito
 * configuration: in cognito mode `validateAuthEnvironment` refuses to start
 * without COGNITO_CLIENT_ID, COGNITO_USER_POOL_ID, COGNITO_REGION and
 * SESSION_ENCRYPTION_KEY, and `infra/docker/compose.selfhost.yml` sets none of
 * those four on `auth`, so merely dropping its AUTH_MODE yields a
 * crash-looping auth container with no issuer at all rather than a silent
 * second one. A deployment that does hand a cognito-mode auth container a
 * working Cognito configuration while this app runs proxy_jwt runs two issuers
 * at once, and the OTP one is not subject to MAX_ACTIVE_API_KEY_CONNECTIONS,
 * so the cap no longer bounds how many keys a user can hold.
 * `infra/docker/compose.selfhost.yml` sets proxy_jwt on both containers;
 * nothing at runtime asserts that the two agree.
 */
import { z } from "zod";

import { getConfiguredAuthMode, type AuthMode } from "@/server/authMode";
import { extractUserId, extractWorkspaceId } from "@/server/userId";
import {
  AGENT_CONNECTION_LABEL_MAX_LENGTH,
  createApiKeyConnection,
  listAgentConnections,
  type CreateApiKeyConnectionResult,
} from "@/server/agent/connections";

export type CreateAgentConnectionDependencies = Readonly<{
  getAuthMode: () => AuthMode;
  createApiKeyConnection: (
    userId: string,
    workspaceId: string,
    label: string,
  ) => Promise<CreateApiKeyConnectionResult>;
}>;

const DEFAULT_CREATE_DEPENDENCIES: CreateAgentConnectionDependencies = {
  getAuthMode: (): AuthMode => getConfiguredAuthMode(process.env),
  createApiKeyConnection,
};

const createRequestSchema = z.object({
  label: z.string().min(1).max(AGENT_CONNECTION_LABEL_MAX_LENGTH).refine(
    (value): boolean => value.trim() !== "",
  ),
});

export const GET = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  const connections = await listAgentConnections(userId, workspaceId);
  return Response.json({
    connections,
    instructions: "Revoked connections stop working on the next agent request.",
  });
};

export const postAgentConnectionRouteWithDeps = async (
  request: Request,
  dependencies: CreateAgentConnectionDependencies,
): Promise<Response> => {
  const authMode = dependencies.getAuthMode();
  if (authMode !== "proxy_jwt") {
    return new Response(
      `Creating an agent API key here requires AUTH_MODE=proxy_jwt; this deployment runs AUTH_MODE=${authMode}. Use the email code flow on the auth service instead.`,
      { status: 400 },
    );
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body. Send {\"label\": \"...\"}", { status: 400 });
  }

  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      `Invalid label. Expected 1-${AGENT_CONNECTION_LABEL_MAX_LENGTH} non-blank characters`,
      { status: 400 },
    );
  }

  const created = await dependencies.createApiKeyConnection(userId, workspaceId, parsed.data.label);
  if (created.kind === "refused_active_limit") {
    return new Response(
      `You already have ${created.activeCount} active agent API keys, the limit of ${created.limit} per user. Revoke a key you no longer use, then create this one again.`,
      { status: 409 },
    );
  }

  return Response.json({
    connection: {
      connectionId: created.connection.connectionId,
      label: created.connection.label,
      createdAt: created.connection.createdAt,
    },
    apiKey: created.connection.apiKey,
    instructions: "Copy this API key now: it is stored hashed and is never shown again. Send it as \"Authorization: ApiKey <key>\" to the /v1 machine API.",
  });
};

export const POST = async (request: Request): Promise<Response> =>
  postAgentConnectionRouteWithDeps(request, DEFAULT_CREATE_DEPENDENCIES);
