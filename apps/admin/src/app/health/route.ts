/** Load balancer health check: proves the server answers, never touches the database. */
export const GET = (): Response => new Response("ok", { status: 200 });
