export type DatabaseConnectionSettings = Readonly<{
  connectionString: string | undefined;
  ssl: boolean;
}>;

type DatabaseEnvironment = Readonly<{
  [name: string]: string | undefined;
  AUTH_MODE?: string;
  DATABASE_URL?: string;
  DB_USER?: string;
  DB_PASSWORD?: string;
  DB_HOST?: string;
  DB_NAME?: string;
}>;

/** Connection settings shared by every web-task pool, so they all reach the same database the same way. */
export const getDatabaseConnectionSettings = (
  environment: DatabaseEnvironment,
): DatabaseConnectionSettings => {
  // AUTH_MODE=cognito means production behind ALB -> always RDS -> always SSL.
  // In cognito mode, construct the URL from individual env vars (ECS injects DB_PASSWORD from Secrets Manager).
  if (environment.AUTH_MODE !== "cognito") {
    return { connectionString: environment.DATABASE_URL, ssl: false };
  }

  const required = ["DB_USER", "DB_PASSWORD", "DB_HOST", "DB_NAME"] as const;
  const missing = required.filter((key) => !environment[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars for cognito mode: ${missing.join(", ")}`);
  }

  // ssl:true enables full certificate verification. RDS certs are signed by
  // Amazon's CA (not in Node.js defaults), so NODE_EXTRA_CA_CERTS must point
  // to the RDS CA bundle (set in CDK, bundle downloaded in Dockerfile).
  return {
    connectionString: `postgresql://${environment.DB_USER}:${encodeURIComponent(environment.DB_PASSWORD!)}@${environment.DB_HOST}:5432/${environment.DB_NAME}`,
    ssl: true,
  };
};
