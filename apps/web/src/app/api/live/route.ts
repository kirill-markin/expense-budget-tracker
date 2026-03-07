/**
 * Liveness endpoint for infrastructure health checks.
 *
 * Must stay independent from Postgres so ECS and ALB can confirm the process is
 * up before database roles, passwords, and migrations are ready.
 */
export const GET = async (): Promise<Response> =>
  Response.json({ status: "ok" });
