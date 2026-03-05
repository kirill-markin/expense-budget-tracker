/**
 * Shared cookie-clearing helper for auth cookies (session + refresh).
 * Appends Set-Cookie headers that expire both cookies immediately.
 */

const AUTH_COOKIE_NAMES: ReadonlyArray<string> = ["session", "refresh"];

export const clearAuthCookies = (headers: Headers): void => {
  const cookieDomain = process.env.COOKIE_DOMAIN ?? "";
  const domainAttr = cookieDomain !== "" ? `; Domain=${cookieDomain}` : "";
  for (const name of AUTH_COOKIE_NAMES) {
    headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax${domainAttr}`,
    );
  }
  // Clear the UI indicator cookie (no HttpOnly — must match how it was set)
  headers.append(
    "Set-Cookie",
    `logged_in=; Path=/; Max-Age=0; Secure; SameSite=Lax${domainAttr}`,
  );
};
