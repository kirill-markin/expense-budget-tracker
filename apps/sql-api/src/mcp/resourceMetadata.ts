import {
  MCP_DOCUMENTATION_URL,
  MCP_SCOPES,
  type McpRuntimeConfig,
} from "./config.js";

export type ProtectedResourceMetadata = Readonly<{
  resource: string;
  authorization_servers: ReadonlyArray<string>;
  bearer_methods_supported: ReadonlyArray<"header">;
  scopes_supported: ReadonlyArray<string>;
  resource_documentation: string;
}>;

export const buildProtectedResourceMetadata = (
  config: McpRuntimeConfig,
): ProtectedResourceMetadata => ({
  resource: config.resource,
  authorization_servers: [config.issuer],
  bearer_methods_supported: ["header"],
  scopes_supported: [...MCP_SCOPES],
  resource_documentation: MCP_DOCUMENTATION_URL,
});

export const buildBearerChallenge = (config: McpRuntimeConfig): string =>
  `Bearer resource_metadata="${config.protectedResourceMetadataUrl}"`;
