export const MCP_SCOPES = ["expenses:read", "expenses:write"] as const;
export const MCP_WEBSITE_URL = "https://expense-budget-tracker.com/";
export const MCP_ICON_URL = "https://expense-budget-tracker.com/icon.svg";
export const MCP_DOCUMENTATION_URL = "https://expense-budget-tracker.com/docs/mcp-connector/";

export type McpScope = typeof MCP_SCOPES[number];

export type McpRuntimeConfig = Readonly<{
  issuer: string;
  resource: string;
  resourceOrigin: string;
  canonicalHost: string;
  protectedResourceMetadataUrl: string;
}>;

const parseAbsoluteUrl = (value: string, variableName: string): URL => {
  try {
    return new URL(value);
  } catch {
    throw new Error(`MCP runtime is misconfigured: ${variableName} must be an absolute URL`);
  }
};

export const getMcpRuntimeConfig = (): McpRuntimeConfig => {
  const issuer = process.env.OAUTH_ISSUER ?? "";
  const resource = process.env.OAUTH_RESOURCE ?? "";
  if (issuer === "" || resource === "") {
    throw new Error("MCP runtime is not configured: OAUTH_ISSUER and OAUTH_RESOURCE are required");
  }

  const issuerUrl = parseAbsoluteUrl(issuer, "OAUTH_ISSUER");
  const resourceUrl = parseAbsoluteUrl(resource, "OAUTH_RESOURCE");
  if (
    issuer !== issuerUrl.origin
    || issuerUrl.username !== ""
    || issuerUrl.password !== ""
  ) {
    throw new Error("MCP runtime is misconfigured: OAUTH_ISSUER must be an origin URL");
  }
  if (
    resource !== `${resourceUrl.origin}/mcp`
    || resourceUrl.pathname !== "/mcp"
    || resourceUrl.search !== ""
    || resourceUrl.hash !== ""
    || resourceUrl.username !== ""
    || resourceUrl.password !== ""
  ) {
    throw new Error("MCP runtime is misconfigured: OAUTH_RESOURCE must be an absolute /mcp URL");
  }

  return {
    issuer,
    resource,
    resourceOrigin: resourceUrl.origin,
    canonicalHost: resourceUrl.host,
    protectedResourceMetadataUrl: `${resourceUrl.origin}/.well-known/oauth-protected-resource/mcp`,
  };
};
