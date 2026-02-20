import { verifyPassword } from "@/server/auth/password";
import { createSessionCookie } from "@/server/auth/session";

interface AttemptRecord {
  count: number;
  firstAttempt: number;
  lockedUntil: number;
}

const attempts = new Map<string, AttemptRecord>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

const getClientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) return forwarded.split(",")[0].trim();
  return "unknown";
};

const checkRateLimit = (ip: string): string | null => {
  const now = Date.now();
  const record = attempts.get(ip);
  if (record === undefined) return null;

  if (record.lockedUntil > now) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return `Too many login attempts. Try again in ${remainingSeconds}s`;
  }

  if (now - record.firstAttempt > WINDOW_MS) {
    attempts.delete(ip);
    return null;
  }

  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    const remainingSeconds = Math.ceil(LOCKOUT_MS / 1000);
    return `Too many login attempts. Try again in ${remainingSeconds}s`;
  }

  return null;
};

const recordFailedAttempt = (ip: string): void => {
  const now = Date.now();
  const record = attempts.get(ip);
  if (record === undefined || now - record.firstAttempt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttempt: now, lockedUntil: 0 });
    return;
  }
  record.count += 1;
};

const resetAttempts = (ip: string): void => {
  attempts.delete(ip);
};

export const POST = async (request: Request): Promise<Response> => {
  const ip = getClientIp(request);
  const rateLimitError = checkRateLimit(ip);
  if (rateLimitError !== null) {
    return Response.json({ error: rateLimitError }, { status: 429 });
  }

  let body: { password?: string };
  try {
    body = (await request.json()) as { password?: string };
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const password = body.password;
  if (password === undefined || password === "") {
    return Response.json({ error: "Password is required" }, { status: 400 });
  }

  let valid: boolean;
  try {
    valid = await verifyPassword(password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }

  if (!valid) {
    recordFailedAttempt(ip);
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  resetAttempts(ip);
  const cookie = await createSessionCookie();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie,
    },
  });
};
