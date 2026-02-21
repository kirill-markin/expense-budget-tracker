export const register = (): void => {
  if (process.env.NODE_ENV !== "production") return;

  const errors: Array<string> = [];

  const authMode = process.env.AUTH_MODE ?? "none";

  if (authMode !== "none" && authMode !== "proxy") {
    errors.push(`Invalid AUTH_MODE="${authMode}". Expected "none" or "proxy"`);
  }

  if (authMode === "proxy") {
    const proxyHeader = process.env.AUTH_PROXY_HEADER;
    if (proxyHeader === undefined || proxyHeader === "") {
      errors.push("AUTH_PROXY_HEADER must be set when AUTH_MODE=proxy");
    }
  }

  if (authMode === "none") {
    const host = process.env.HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(
        `WARNING: AUTH_MODE=none with HOST=${host}. The app has no authentication and should only bind to localhost`,
      );
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    errors.push("DATABASE_URL must be set in production");
  }

  if (errors.length > 0) {
    throw new Error(
      `Startup validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
};
