/**
 * App-side wrappers over the shared machine-readable agent contract.
 */
import {
  RUN_SQL_INPUT,
  buildCreateWorkspaceAction as buildCreateWorkspaceActionBase,
  buildErrorEnvelope,
  buildListWorkspacesAction as buildListWorkspacesActionBase,
  buildRunSqlAction as buildRunSqlActionBase,
  buildSchemaAction as buildSchemaActionBase,
  buildSelectWorkspaceAction as buildSelectWorkspaceActionBase,
  buildSendCodeAction as buildSendCodeActionBase,
  buildSuccessEnvelope,
  type AgentAction,
  type AgentEnvelope,
} from "@expense-budget-tracker/agent-shared";

const AGENT_API_BASE_PATH = "/api/agent";

export type { AgentAction, AgentEnvelope } from "@expense-budget-tracker/agent-shared";
export { buildErrorEnvelope, buildSuccessEnvelope } from "@expense-budget-tracker/agent-shared";

export const buildListWorkspacesAction = (): AgentAction =>
  buildListWorkspacesActionBase({ url: `${AGENT_API_BASE_PATH}/workspaces` });

export const buildSendCodeAction = (url: string): AgentAction =>
  buildSendCodeActionBase({ url });

export const buildCreateWorkspaceAction = (): AgentAction =>
  buildCreateWorkspaceActionBase({ url: `${AGENT_API_BASE_PATH}/workspaces` });

export const buildSelectWorkspaceAction = (): AgentAction =>
  buildSelectWorkspaceActionBase({ url: `${AGENT_API_BASE_PATH}/workspaces/{workspaceId}/select` });

export const buildRunSqlAction = (): AgentAction =>
  buildRunSqlActionBase({ url: `${AGENT_API_BASE_PATH}/sql` }, RUN_SQL_INPUT);

export const buildSchemaAction = (): AgentAction =>
  buildSchemaActionBase({ url: `${AGENT_API_BASE_PATH}/schema` });
