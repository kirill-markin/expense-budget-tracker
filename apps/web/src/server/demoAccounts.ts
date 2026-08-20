/**
 * Demo/review account detection for the web app.
 *
 * The auth service signs these accounts in without an email OTP whenever
 * DEMO_EMAIL_DOSTIP lists their address, and that address is committed in a
 * public repository. The web app therefore has to recognise the same accounts
 * so it can cap how much model spend they can produce.
 *
 * This is deliberately an independent, email-only reader instead of an import
 * from apps/auth/src/server/demoEmailAccess.ts. The web image ships no auth
 * sources, and the auth loader additionally requires DEMO_PASSWORD_DOSTIP — a
 * secret that stays on the auth container and would make the web task throw.
 *
 * An unset or empty DEMO_EMAIL_DOSTIP means there are no demo accounts, which
 * correctly disables every demo-only restriction.
 */

const DEMO_EMAIL_GUARDIAN_DOMAIN = "example.com";

let resolvedAllowlist: ReadonlySet<string> | undefined;

const normalizeDemoEmail = (value: string): string =>
  value.trim().toLowerCase();

const isGuardianDemoEmail = (email: string): boolean =>
  email.endsWith(`@${DEMO_EMAIL_GUARDIAN_DOMAIN}`);

const parseDemoEmailAllowlist = (rawValue: string): ReadonlySet<string> => {
  const normalized = rawValue
    .split(",")
    .map(normalizeDemoEmail)
    .filter((value) => value !== "");

  const invalid = normalized.find((value) => !isGuardianDemoEmail(value));
  if (invalid !== undefined) {
    throw new Error(
      `DEMO_EMAIL_DOSTIP only supports insecure review/demo emails in @${DEMO_EMAIL_GUARDIAN_DOMAIN}, got "${invalid}"`,
    );
  }

  return new Set(normalized);
};

/**
 * Resolve the allowlist once per process, like the auth-side loader does.
 *
 * The value is deployment configuration, so re-reading and re-validating it on
 * every chat request only buys a way for a malformed value to turn every
 * request into a server error. Resolving it once keeps the validation loud and
 * one-off.
 */
const getDemoEmailAllowlist = (): ReadonlySet<string> => {
  if (resolvedAllowlist !== undefined) {
    return resolvedAllowlist;
  }

  resolvedAllowlist = parseDemoEmailAllowlist(process.env.DEMO_EMAIL_DOSTIP ?? "");
  return resolvedAllowlist;
};

export const isDemoAccountEmail = (email: string): boolean => {
  const allowlist = getDemoEmailAllowlist();
  if (allowlist.size === 0) {
    return false;
  }

  return allowlist.has(normalizeDemoEmail(email));
};

export const resetDemoAccountAllowlistForTests = (): void => {
  resolvedAllowlist = undefined;
};
