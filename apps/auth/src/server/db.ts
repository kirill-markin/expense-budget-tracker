/**
 * Postgres helpers for the auth service.
 *
 * The auth service uses a dedicated DB role with access limited to the auth
 * schema and narrow helper functions. It must not reuse the main app role.
 */
import pg from "pg";

const getConnectionString = (): string => {
  const directUrl = process.env.AUTH_DATABASE_URL ?? "";
  if (directUrl !== "") {
    return directUrl;
  }

  const host = process.env.DB_HOST ?? "";
  const database = process.env.DB_NAME ?? "";
  const user = process.env.DB_USER ?? "";
  const password = process.env.DB_PASSWORD ?? "";

  if (host === "" || database === "" || user === "" || password === "") {
    throw new Error("Auth DB is not configured: set AUTH_DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD");
  }

  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:5432/${database}`;
};

let pool: pg.Pool | undefined;

const getPool = (): pg.Pool => {
  if (pool !== undefined) {
    return pool;
  }

  const useSsl = (process.env.DB_HOST ?? "") !== "";
  pool = new pg.Pool({
    connectionString: getConnectionString(),
    ssl: useSsl ? true : false,
  });
  return pool;
};

type QueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;

export const query = (text: string, params: ReadonlyArray<unknown>): Promise<pg.QueryResult> =>
  getPool().query(text, params as Array<unknown>);

export const withTransaction = async <T>(
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await getPool().connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const boundQuery: QueryFn = (text, params) =>
      client.query(text, params as Array<unknown>);
    const result = await callback(boundQuery);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
};
