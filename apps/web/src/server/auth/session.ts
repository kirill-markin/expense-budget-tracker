import { query } from "@/server/db";

const SESSION_COOKIE_NAME = "session";

const extractSessionId = (request: Request): string | null => {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  return match !== null ? match[1] : null;
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
    "SELECT session_id, expires_at FROM sessions WHERE session_id = $1",
    [sessionId],
  );

  if (result.rows.length === 0) {
    throw new Error("Invalid session");
  }

  const row = result.rows[0] as { session_id: string; expires_at: Date };
  if (new Date(row.expires_at) < new Date()) {
    throw new Error("Session expired");
  }

  await query(
    "UPDATE sessions SET last_active = now() WHERE session_id = $1",
    [sessionId],
  );
};
