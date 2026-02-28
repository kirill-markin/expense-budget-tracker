/**
 * Database URL resolution for SQL API Lambdas.
 *
 * Lambda: fetches credentials from Secrets Manager using DB_SECRET_ARN,
 * then constructs the URL from DB_HOST and DB_NAME.
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

let resolvedDatabaseUrl: string | undefined;

export async function getDatabaseUrl(): Promise<string> {
  if (resolvedDatabaseUrl) return resolvedDatabaseUrl;

  const secretArn = process.env.DB_SECRET_ARN;
  if (secretArn) {
    const client = new SecretsManagerClient({});
    const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const secret: { username: string; password: string } = JSON.parse(resp.SecretString!);
    const host = process.env.DB_HOST!;
    const dbName = process.env.DB_NAME!;
    resolvedDatabaseUrl = `postgresql://${secret.username}:${encodeURIComponent(secret.password)}@${host}:5432/${dbName}`;
  } else {
    resolvedDatabaseUrl = process.env.DATABASE_URL!;
  }

  return resolvedDatabaseUrl;
}
