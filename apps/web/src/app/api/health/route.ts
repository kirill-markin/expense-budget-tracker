/**
 * Readiness endpoint.
 *
 * Returns success only when the web process can reach Postgres with the current
 * app role credentials.
 */
import { getPool } from "../../../server/db";
import { log } from "../../../server/logger";

export const GET = async (): Promise<Response> => {
  try {
    await getPool().query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "api", action: "error", route: "/api/health", method: "GET", error: message });
    return Response.json({ status: "error" }, { status: 503 });
  }
};
