/**
 * Explicit Authorization header parsing shared by proxy and agent routes.
 */
export type AuthTransport = "session" | "bearer" | "api_key";

export type ParsedAuthorization = Readonly<{
  transport: "bearer" | "api_key";
  credentials: string;
}>;

export const parseAuthorizationHeader = (value: string | null): ParsedAuthorization | null => {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex <= 0) {
    return null;
  }

  const scheme = trimmed.slice(0, spaceIndex);
  const credentials = trimmed.slice(spaceIndex + 1).trim();
  if (credentials === "") {
    return null;
  }

  if (scheme === "Bearer") {
    return { transport: "bearer", credentials };
  }

  if (scheme === "ApiKey") {
    return { transport: "api_key", credentials };
  }

  return null;
};

export const hasNonSessionAuthorization = (value: string | null): boolean =>
  parseAuthorizationHeader(value) !== null;

export const hasApiKeyAuthorization = (value: string | null): boolean => {
  const parsed = parseAuthorizationHeader(value);
  return parsed !== null && parsed.transport === "api_key";
};
