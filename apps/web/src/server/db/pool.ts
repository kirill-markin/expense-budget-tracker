import pg from "pg";

// AUTH_MODE=cognito means production behind ALB -> always RDS -> always SSL.
// In cognito mode, construct the URL from individual env vars (ECS injects DB_PASSWORD from Secrets Manager).
if (process.env.AUTH_MODE === "cognito") {
  const required = ["DB_USER", "DB_PASSWORD", "DB_HOST", "DB_NAME"] as const;
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars for cognito mode: ${missing.join(", ")}`);
  }
}

const connectionString = process.env.AUTH_MODE === "cognito"
  ? `postgresql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD!)}@${process.env.DB_HOST}:5432/${process.env.DB_NAME}`
  : process.env.DATABASE_URL;

// ssl:true enables full certificate verification. RDS certs are signed by
// Amazon's CA (not in Node.js defaults), so NODE_EXTRA_CA_CERTS must point
// to the RDS CA bundle (set in CDK, bundle downloaded in Dockerfile).
const ssl = process.env.AUTH_MODE === "cognito" ? true : false;

const pool = new pg.Pool({ connectionString, ssl });

/** Execute a query without RLS context (global tables only). */
export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  pool.query(text, params as Array<unknown>);

export const getPool = (): pg.Pool => pool;
