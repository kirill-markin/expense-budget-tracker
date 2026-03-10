/**
 * Optional mirror of the agent discovery document.
 */
import { buildAgentDiscoveryEnvelope } from "@/server/agentDiscovery";

export const GET = async (request: Request): Promise<Response> =>
  Response.json(buildAgentDiscoveryEnvelope(request));
