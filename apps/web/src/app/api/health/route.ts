import { getPool } from "../../../server/db";

export const GET = async (): Promise<Response> => {
  try {
    await getPool().query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "error" }, { status: 503 });
  }
};
