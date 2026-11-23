export type CognitoAuthConfig = Readonly<{
  mode: "cognito";
  authDomain: string;
  cookieDomain: string;
  cognitoRegion: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
}>;

export type NoneAuthConfig = Readonly<{ mode: "none" }>;

export type DatabaseConfig = Readonly<{
  connectionString: string;
  ssl: boolean;
}>;

export type AdminConfig = Readonly<{
  auth: CognitoAuthConfig | NoneAuthConfig;
  adminOrigin: string;
  adminEmails: ReadonlyArray<string>;
  analyticsExcludedEmails: ReadonlyArray<string>;
  database: DatabaseConfig;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

const requireNonEmpty = (environment: Environment, name: string): string => {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set to a non-empty value for the admin app`);
  }
  return value.trim();
};

const parseAuthMode = (environment: Environment): "cognito" | "none" => {
  const value = environment.ADMIN_AUTH_MODE;
  if (value === "cognito" || value === "none") return value;
  throw new Error(`ADMIN_AUTH_MODE must be "cognito" or "none", got ${JSON.stringify(value ?? null)}`);
};

/** A comma list of trimmed emails; an empty entry such as `a@x.com,,b@x.com` is a typo and fails. */
const parseEmailList = (name: string, value: string): ReadonlyArray<string> => {
  if (value.trim() === "") return [];
  return value.split(",").map((entry: string): string => {
    const email = entry.trim();
    if (email === "" || !email.includes("@")) {
      throw new Error(`${name} contains an invalid email entry ${JSON.stringify(entry)}; expected a comma list of emails`);
    }
    return email;
  });
};

/** Matched exactly, so a capital letter could only match an account created outside the login service, which stores emails lowercase. */
const parseAdminEmails = (environment: Environment): ReadonlyArray<string> => {
  const emails = parseEmailList("ADMIN_EMAILS", requireNonEmpty(environment, "ADMIN_EMAILS"));
  if (emails.length === 0) {
    throw new Error("ADMIN_EMAILS must list at least one email");
  }
  for (const email of emails) {
    if (email !== email.toLowerCase()) {
      throw new Error(`ADMIN_EMAILS entry ${JSON.stringify(email)} must be lowercase: the login service stores every account email lowercase`);
    }
  }
  return emails;
};

/** Must be present so that excluding nobody is a deliberate choice, but may be empty. Lowercased for case-insensitive exclusion. */
const parseAnalyticsExcludedEmails = (environment: Environment): ReadonlyArray<string> => {
  const value = environment.ANALYTICS_EXCLUDED_EMAILS;
  if (value === undefined) {
    throw new Error("ANALYTICS_EXCLUDED_EMAILS must be set; use an empty value to exclude no extra emails");
  }
  return parseEmailList("ANALYTICS_EXCLUDED_EMAILS", value).map((email: string): string => email.toLowerCase());
};

const parseAdminOrigin = (environment: Environment, mode: "cognito" | "none"): string => {
  const value = requireNonEmpty(environment, "ADMIN_ORIGIN");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ADMIN_ORIGIN must be an absolute origin such as https://admin.example.com, got ${JSON.stringify(value)}`);
  }
  if (url.origin !== value) {
    throw new Error(`ADMIN_ORIGIN must be a bare origin without path or trailing slash, got ${JSON.stringify(value)}`);
  }
  if (mode === "cognito" && url.protocol !== "https:") {
    throw new Error(`ADMIN_ORIGIN must use https when ADMIN_AUTH_MODE=cognito, got ${JSON.stringify(value)}`);
  }
  return value;
};

/** Cognito mode means production on ECS, where the RDS connection is assembled from parts and always uses SSL. */
const parseDatabaseConfig = (environment: Environment, mode: "cognito" | "none"): DatabaseConfig => {
  if (mode === "none") {
    return { connectionString: requireNonEmpty(environment, "DATABASE_URL"), ssl: false };
  }
  const user = requireNonEmpty(environment, "DB_USER");
  const password = requireNonEmpty(environment, "DB_PASSWORD");
  const host = requireNonEmpty(environment, "DB_HOST");
  const name = requireNonEmpty(environment, "DB_NAME");
  // ssl:true verifies the certificate; NODE_EXTRA_CA_CERTS points at the RDS CA bundle from the Dockerfile.
  return {
    connectionString: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/${name}`,
    ssl: true,
  };
};

export const parseAdminConfig = (environment: Environment): AdminConfig => {
  const mode = parseAuthMode(environment);
  const auth: CognitoAuthConfig | NoneAuthConfig = mode === "none"
    ? { mode: "none" }
    : {
      mode: "cognito",
      authDomain: requireNonEmpty(environment, "AUTH_DOMAIN"),
      cookieDomain: requireNonEmpty(environment, "COOKIE_DOMAIN"),
      cognitoRegion: requireNonEmpty(environment, "COGNITO_REGION"),
      cognitoUserPoolId: requireNonEmpty(environment, "COGNITO_USER_POOL_ID"),
      cognitoClientId: requireNonEmpty(environment, "COGNITO_CLIENT_ID"),
    };
  return {
    auth,
    adminOrigin: parseAdminOrigin(environment, mode),
    adminEmails: parseAdminEmails(environment),
    analyticsExcludedEmails: parseAnalyticsExcludedEmails(environment),
    database: parseDatabaseConfig(environment, mode),
  };
};

let cachedConfig: AdminConfig | undefined;

export const getAdminConfig = (): AdminConfig => {
  if (cachedConfig === undefined) {
    cachedConfig = parseAdminConfig(process.env);
  }
  return cachedConfig;
};
