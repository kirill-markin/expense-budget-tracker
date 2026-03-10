/**
 * Shared machine-readable envelope for app-side agent setup endpoints.
 */
export type AgentAction = Readonly<{
  name: string;
  method: "GET" | "POST";
  url?: string;
  urlTemplate?: string;
  input?: Readonly<Record<string, string>>;
  auth?: "ApiKey" | "none";
}>;

export type AgentEnvelope = Readonly<{
  ok: boolean;
  data: Readonly<Record<string, unknown>>;
  actions: ReadonlyArray<AgentAction>;
  instructions: string;
  error?: Readonly<{
    code: string;
    message: string;
  }>;
}>;

export const buildListWorkspacesAction = (): AgentAction => ({
  name: "list_workspaces",
  method: "GET",
  url: "/api/agent/workspaces",
  auth: "ApiKey",
});

export const buildCreateWorkspaceAction = (): AgentAction => ({
  name: "create_workspace",
  method: "POST",
  url: "/api/agent/workspaces",
  input: { name: "string" },
  auth: "ApiKey",
});

export const buildSelectWorkspaceAction = (): AgentAction => ({
  name: "select_workspace",
  method: "POST",
  urlTemplate: "/api/agent/workspaces/{workspaceId}/select",
  auth: "ApiKey",
});

export const buildSuccessEnvelope = (
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
  instructions: string,
): AgentEnvelope => ({
  ok: true,
  data,
  actions,
  instructions,
});

export const buildErrorEnvelope = (
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
  instructions: string,
  code: string,
  message: string,
): AgentEnvelope => ({
  ok: false,
  data,
  actions,
  instructions,
  error: { code, message },
});
