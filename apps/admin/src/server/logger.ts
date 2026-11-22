type AdminAuthEvent =
  | Readonly<{ domain: "admin_auth"; action: "refresh" }>
  | Readonly<{ domain: "admin_auth"; action: "refresh_failed"; error: string }>
  | Readonly<{ domain: "admin_auth"; action: "session_invalid"; error: string }>
  | Readonly<{ domain: "admin_auth"; action: "forbidden"; email: string | null; path: string }>
  | Readonly<{ domain: "admin_auth"; action: "method_not_allowed"; method: string; path: string }>
  | Readonly<{ domain: "admin_auth"; action: "non_loopback_host"; host: string | null; path: string }>;

/**
 * `pool_error` is an idle pooled connection closed by the server (RDS
 * maintenance, restart, failover); node-postgres discards the client itself.
 */
type DbEvent =
  | Readonly<{ domain: "db"; action: "pool_error"; error: string }>
  | Readonly<{ domain: "db"; action: "query"; name: string; durationMs: number; rowCount: number }>
  | Readonly<{ domain: "db"; action: "query_error"; name: string; durationMs: number; error: string }>;

type LogEvent = AdminAuthEvent | DbEvent;

export const log = (event: LogEvent): void => {
  console.log(JSON.stringify(event));
};
