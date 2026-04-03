/**
 * Insecure review/demo email bypass for E2E tests.
 *
 * When DEMO_EMAIL_DOSTIP is configured, listed emails in @example.com can
 * sign in via a shared password instead of the real Email OTP flow.
 * This intentionally disables OTP protection for synthetic review accounts.
 *
 * The bypass is restricted to the @example.com guardian domain and requires
 * an explicit allowlist — no production email can ever match.
 */

type DemoEmailAccessConfig = Readonly<{
  emailAllowlist: ReadonlySet<string>;
  sharedPassword: string | null;
}>;

const DEMO_EMAIL_GUARDIAN_DOMAIN = "example.com";
const DEMO_AGENT_OTP_SESSION_PREFIX = "demo-agent:";

let resolvedConfig: DemoEmailAccessConfig | undefined;

const normalizeDemoEmail = (value: string): string =>
  value.trim().toLowerCase();

const isGuardianDemoEmail = (email: string): boolean =>
  email.endsWith(`@${DEMO_EMAIL_GUARDIAN_DOMAIN}`);

const parseDemoEmailAllowlist = (rawValue: string): ReadonlySet<string> => {
  const normalized = rawValue
    .split(",")
    .map(normalizeDemoEmail)
    .filter((v) => v !== "");

  const invalid = normalized.find((v) => !isGuardianDemoEmail(v));
  if (invalid !== undefined) {
    throw new Error(
      `DEMO_EMAIL_DOSTIP only supports insecure review/demo emails in @${DEMO_EMAIL_GUARDIAN_DOMAIN}, got "${invalid}"`,
    );
  }

  return new Set(normalized);
};

export const getDemoEmailAccessConfig = (): DemoEmailAccessConfig => {
  if (resolvedConfig !== undefined) {
    return resolvedConfig;
  }

  const rawAllowlist = process.env.DEMO_EMAIL_DOSTIP ?? "";
  const emailAllowlist = parseDemoEmailAllowlist(rawAllowlist);
  const sharedPassword = process.env.DEMO_PASSWORD_DOSTIP ?? "";

  if (emailAllowlist.size > 0 && sharedPassword === "") {
    throw new Error(
      "DEMO_PASSWORD_DOSTIP is required when DEMO_EMAIL_DOSTIP is configured for insecure review/demo access",
    );
  }

  resolvedConfig = {
    emailAllowlist,
    sharedPassword: sharedPassword === "" ? null : sharedPassword,
  };
  return resolvedConfig;
};

export const getDemoEmailPassword = (email: string): string | null => {
  const config = getDemoEmailAccessConfig();
  const normalized = normalizeDemoEmail(email);

  if (!isGuardianDemoEmail(normalized) || !config.emailAllowlist.has(normalized)) {
    return null;
  }

  return config.sharedPassword;
};

export const createDemoAgentOtpSession = (email: string): string => {
  const normalized = normalizeDemoEmail(email);
  if (getDemoEmailPassword(normalized) === null) {
    throw new Error(`Demo agent OTP session requires an allowlisted review email, got "${email}"`);
  }

  return `${DEMO_AGENT_OTP_SESSION_PREFIX}${normalized}`;
};

export const isDemoAgentOtpSession = (
  email: string,
  session: string,
): boolean => {
  const normalized = normalizeDemoEmail(email);
  return session === `${DEMO_AGENT_OTP_SESSION_PREFIX}${normalized}`
    && getDemoEmailPassword(normalized) !== null;
};

export const resetDemoEmailAccessConfigForTests = (): void => {
  resolvedConfig = undefined;
};
