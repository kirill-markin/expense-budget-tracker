import { destroySession, clearSessionCookie } from "@/server/auth/session";

export const POST = async (request: Request): Promise<Response> => {
  await destroySession(request);

  return new Response(null, {
    status: 303,
    headers: {
      "Set-Cookie": clearSessionCookie(),
      "Location": "/login",
    },
  });
};
