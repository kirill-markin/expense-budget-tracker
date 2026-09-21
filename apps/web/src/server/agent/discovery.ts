/**
 * Discovery document for terminal-first agent onboarding.
 */
import {
  buildAgentDiscoveryEnvelope as buildSharedAgentDiscoveryEnvelope,
  type AgentOnboarding,
} from "@expense-budget-tracker/agent-shared/discovery";
import { type AgentEnvelope } from "@/server/agent/envelope";
import { getConfiguredAuthMode } from "@/server/authMode";

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

/**
 * The browser app is this service. Behind a proxy the request URL is the
 * internal container address, so the configured public origin comes first;
 * CORS_ORIGIN is validated as an absolute origin at startup in every mode
 * that reaches the browser onboarding.
 */
const getAppBaseUrl = (request: Request): string => {
  const configuredOrigin = process.env.CORS_ORIGIN ?? "";

  return configuredOrigin !== "" ? new URL(configuredOrigin).origin : new URL(request.url).origin;
};

/**
 * proxy_jwt is the mode that removes the email OTP routes from the auth
 * service and puts key creation in Settings instead, so it is the mode whose
 * envelope must describe the browser path. Every other mode keeps the email
 * OTP shape, which is what the cognito deployment serves.
 */
const getOnboarding = (request: Request, authBaseUrl: string): AgentOnboarding =>
  getConfiguredAuthMode(process.env) === "proxy_jwt"
    ? { kind: "browser_api_key", appBaseUrl: getAppBaseUrl(request) }
    : { kind: "email_otp", bootstrapUrl: `${authBaseUrl}/api/agent/send-code` };

export const buildAgentDiscoveryEnvelope = (request: Request): AgentEnvelope => {
  const apiBaseUrl = getApiBaseUrl(request);
  const authBaseUrl = getAuthBaseUrl(request);
  const mcpUrl = new URL(apiBaseUrl);
  mcpUrl.hostname = mcpUrl.hostname.replace(/^api\./u, "mcp.");
  mcpUrl.pathname = "/mcp";

  return buildSharedAgentDiscoveryEnvelope({
    apiBaseUrl,
    authBaseUrl,
    onboarding: getOnboarding(request, authBaseUrl),
    mcpUrl: mcpUrl.toString(),
  });
};
