/**
 * Identity mode of the auth service, selected by AUTH_MODE.
 *
 * cognito   — the browser session is a Cognito ID token in the `session`
 *             cookie, established by the email OTP login page hosted here.
 * proxy_jwt — an upstream proxy authenticates the user and forwards a signed
 *             JWT in the AUTH_PROXY_JWT_HEADER header. This service hosts no
 *             login of its own in that mode.
 *
 * An unset or blank AUTH_MODE is the Cognito path, because the AWS deployment
 * runs the auth container without that variable. The web app's AUTH_MODE=none
 * has no counterpart here: this service exists only to establish an identity,
 * so a deployment that needs none of it does not run it.
 */
export type AuthServiceMode = "cognito" | "proxy_jwt";

export type AuthServiceModeEnv = Readonly<Record<string, string | undefined>>;

export const getAuthServiceMode = (env: AuthServiceModeEnv): AuthServiceMode => {
  const rawAuthMode = env.AUTH_MODE ?? "";
  if (rawAuthMode.trim() === "" || rawAuthMode === "cognito") return "cognito";
  if (rawAuthMode === "proxy_jwt") return "proxy_jwt";
  throw new Error(
    `Invalid AUTH_MODE="${rawAuthMode}" for the auth service. Expected "cognito" or "proxy_jwt"`,
  );
};
