/**
 * RFC 2606 reserved names that exist so documentation and tests can never
 * address real mail. Starting the Email OTP flow for one of them makes Cognito
 * invoke the custom email sender, which Resend rejects as a validation error,
 * so both OTP routes refuse them before any code is sent.
 */

const RESERVED_DOMAINS: ReadonlySet<string> = new Set([
  "example.com",
  "example.org",
  "example.net",
]);

const RESERVED_SUFFIX_LABELS: ReadonlyArray<string> = ["test", "invalid", "localhost"];

export const hasUndeliverableReservedDomain = (email: string): boolean => {
  const separatorIndex = email.lastIndexOf("@");
  if (separatorIndex === -1) {
    return false;
  }

  const rawDomain = email.slice(separatorIndex + 1).trim().toLowerCase();
  // A single trailing dot is the DNS root label: `example.com.` names `example.com`.
  const domain = rawDomain.endsWith(".") ? rawDomain.slice(0, -1) : rawDomain;
  return RESERVED_DOMAINS.has(domain)
    || RESERVED_SUFFIX_LABELS.some((label) => domain === label || domain.endsWith(`.${label}`));
};
