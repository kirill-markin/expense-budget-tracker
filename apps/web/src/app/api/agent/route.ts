/**
 * Canonical discovery document for AI agents.
 *
 * This endpoint is intentionally public so an agent can understand the service,
 * bootstrap auth on auth.*, and learn the next steps without prior knowledge.
 */
import { buildAgentDiscoveryEnvelope } from "@/server/agentDiscovery";

export const GET = async (request: Request): Promise<Response> =>
  Response.json(buildAgentDiscoveryEnvelope(request));
