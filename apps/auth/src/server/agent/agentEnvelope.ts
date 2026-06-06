/**
 * Thin auth-side facade over the shared machine-readable agent contract.
 */
import * as agentContract from "@expense-budget-tracker/agent-shared";

export type AgentAction = import("@expense-budget-tracker/agent-shared").AgentAction;
export type AgentEnvelope = import("@expense-budget-tracker/agent-shared").AgentEnvelope;
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
