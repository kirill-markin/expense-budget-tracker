import { randomBytes } from "node:crypto";
import { query } from "@/server/db";

const SESSION_COOKIE_NAME = "session";
const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const isSecureContext = (): boolean => {
  const origin = process.env.CORS_ORIGIN ?? "";
  return origin.startsWith("https://");
};

const extractSessionId = (request: Request): string | null => {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  return match !== null ? match[1] : null;
};

const buildSetCookie = (sessionId: string, maxAgeSeconds: number): string => {
  const secure = isSecureContext();
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
};

export const createSessionCookie = async (): Promise<string> => {
  const sessionId = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS);

  await query(
    "INSERT INTO sessions (session_id, created_at, last_active, expires_at) VALUES ($1, now(), now(), $2)",
    [sessionId, expiresAt],
  );

  const maxAgeSeconds = Math.floor(SESSION_ABSOLUTE_LIFETIME_MS / 1000);
  return buildSetCookie(sessionId, maxAgeSeconds);
};

export const destroySession = async (request: Request): Promise<void> => {
  const sessionId = extractSessionId(request);
  if (sessionId !== null) {
    await query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
  }
};

export const clearSessionCookie = (): string =>
  buildSetCookie("deleted", 0);

export const rotateSession = async (request: Request): Promise<string> => {
  await destroySession(request);
  return createSessionCookie();
};

export const validateSession = async (request: Request): Promise<void> => {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret === "") {
    return;
  }

  const sessionId = extractSessionId(request);
  if (sessionId === null) {
    throw new Error("Missing session cookie");
  }

  const result = await query(
    "SELECT session_id, created_at, last_active, expires_at FROM sessions WHERE session_id = $1",
    [sessionId],
  );

  if (result.rows.length === 0) {
    throw new Error("Invalid session");
  }

  const row = result.rows[0] as {
    session_id: string;
    created_at: Date;
    last_active: Date;
    expires_at: Date;
  };

  if (new Date(row.expires_at) < new Date()) {
    await query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    throw new Error("Session expired");
  }

  const idleDeadline = new Date(new Date(row.last_active).getTime() + SESSION_IDLE_TIMEOUT_MS);
  if (idleDeadline < new Date()) {
    await query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    throw new Error("Session expired due to inactivity");
  }

  await query(
    "UPDATE sessions SET last_active = now() WHERE session_id = $1",
    [sessionId],
  );
};
