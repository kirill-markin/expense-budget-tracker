/**
 * Thin auth-side facade over the shared machine-readable agent contract.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentContract = require("../../../web/src/server/agentContract.js") as typeof import("../../../web/src/server/agentContract.js");

export type AgentAction = import("../../../web/src/server/agentContract.js").AgentAction;
export type AgentEnvelope = import("../../../web/src/server/agentContract.js").AgentEnvelope;
export const VERIFY_CODE_INPUT = agentContract.VERIFY_CODE_INPUT;
export const buildErrorEnvelope = agentContract.buildErrorEnvelope;
export const buildSuccessEnvelope = agentContract.buildSuccessEnvelope;

export const buildVerifyCodeAction = (): AgentAction =>
  agentContract.buildVerifyCodeAction({ url: "/api/agent/verify-code" });

export const buildLoadAccountAction = (apiBaseUrl: string): AgentAction =>
  agentContract.buildLoadAccountAction({ baseUrl: apiBaseUrl, path: "/me" });

export const buildListWorkspacesAction = (apiBaseUrl: string): AgentAction =>
  agentContract.buildListWorkspacesAction({ baseUrl: apiBaseUrl, path: "/workspaces" });

export const buildSelectWorkspaceAction = (apiBaseUrl: string): AgentAction =>
  agentContract.buildSelectWorkspaceAction({ baseUrl: apiBaseUrl, path: "/workspaces/{workspaceId}/select" });

export const buildSchemaAction = (apiBaseUrl: string): AgentAction =>
  agentContract.buildSchemaAction({ baseUrl: apiBaseUrl, path: "/schema" });
