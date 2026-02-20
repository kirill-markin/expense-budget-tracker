export const register = (): void => {
  if (process.env.NODE_ENV !== "production") return;

  const errors: Array<string> = [];

  const sessionSecret = process.env.SESSION_SECRET;
  if (
    sessionSecret === undefined ||
    sessionSecret === "" ||
    sessionSecret === "change-me-to-a-random-string"
  ) {
    errors.push("SESSION_SECRET must be set to a secure random value in production");
  }

  const passwordHash = process.env.PASSWORD_HASH;
  if (passwordHash === undefined || passwordHash === "") {
    errors.push("PASSWORD_HASH must be set to an Argon2id hash in production");
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
