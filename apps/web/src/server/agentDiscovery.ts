/**
 * Discovery document for terminal-first agent onboarding.
 */
import { buildAgentDiscoveryEnvelope as buildSharedAgentDiscoveryEnvelope } from "@/server/agentDiscoveryContract";
import { type AgentEnvelope } from "@/server/agentEnvelope";

const getApiBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const configuredOrigin = process.env.CORS_ORIGIN ?? "";

  if (configuredOrigin !== "") {
    return `${new URL(configuredOrigin).protocol}//api.${process.env.AUTH_DOMAIN?.replace(/^auth\./u, "") ?? requestUrl.host.replace(/^app\./u, "")}/v1`;
  }

  return `${requestUrl.protocol}//${requestUrl.host.replace(/^app\./u, "api.")}/v1`;
};

const getAuthBaseUrl = (request: Request): string => {
  const requestUrl = new URL(request.url);
  const configuredDomain = process.env.AUTH_DOMAIN ?? "";
  const configuredOrigin = process.env.CORS_ORIGIN ?? "";
  const protocol = configuredOrigin !== "" ? new URL(configuredOrigin).protocol : requestUrl.protocol;

  if (configuredDomain !== "") {
    return `${protocol}//${configuredDomain}`;
  }

  return requestUrl.origin;
};

export const buildAgentDiscoveryEnvelope = (request: Request): AgentEnvelope => {
  const apiBaseUrl = getApiBaseUrl(request);
  const authBaseUrl = getAuthBaseUrl(request);

  return buildSharedAgentDiscoveryEnvelope({
    apiBaseUrl,
    authBaseUrl,
    bootstrapUrl: `${authBaseUrl}/api/agent/send-code`,
  });
};
