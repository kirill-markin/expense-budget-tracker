/**
 * Shared response envelope for terminal-first agent auth endpoints.
 *
 * The strings live here so the flow is documented next to the implementation
 * instead of in a separate docs file.
 */
export type AgentAction = Readonly<{
  name: string;
  method: "GET" | "POST";
  url?: string;
  urlTemplate?: string;
  input?: Readonly<Record<string, string>>;
  auth?: "none" | "ApiKey";
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

export const VERIFY_CODE_INPUT: Readonly<Record<string, string>> = {
  code: "string",
  otpSessionToken: "string",
  label: "string",
};

export const buildVerifyCodeAction = (): AgentAction => ({
  name: "verify_code",
  method: "POST",
  url: "/api/agent/verify-code",
  input: VERIFY_CODE_INPUT,
  auth: "none",
});

export const buildLoadAccountAction = (apiBaseUrl: string): AgentAction => ({
  name: "load_account",
  method: "GET",
  url: `${apiBaseUrl}/me`,
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
