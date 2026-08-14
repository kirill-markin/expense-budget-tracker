import { MCP_SCOPES, type McpRuntimeConfig } from "./config.js";

export type ProtectedResourceMetadata = Readonly<{
  resource: string;
  authorization_servers: ReadonlyArray<string>;
  bearer_methods_supported: ReadonlyArray<"header">;
  scopes_supported: ReadonlyArray<string>;
}>;

export const buildProtectedResourceMetadata = (
  config: McpRuntimeConfig,
): ProtectedResourceMetadata => ({
  resource: config.resource,
  authorization_servers: [config.issuer],
  bearer_methods_supported: ["header"],
  scopes_supported: [...MCP_SCOPES],
});

export const buildBearerChallenge = (config: McpRuntimeConfig): string =>
  `Bearer resource_metadata="${config.protectedResourceMetadataUrl}"`;
