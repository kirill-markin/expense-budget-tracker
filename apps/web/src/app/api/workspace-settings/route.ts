import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getReportCurrency } from "@/server/reportCurrency";
import { updateReportCurrency } from "@/server/updateReportCurrency";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return Response.json({ reportingCurrency: "USD" });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const reportingCurrency = await getReportCurrency(userId, workspaceId);
    return Response.json({ reportingCurrency });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database query failed: ${message}`, { status: 500 });
  }
};

type PutBody = Readonly<{
  reportingCurrency: unknown;
}>;

export const PUT = async (request: Request): Promise<Response> => {
  let body: PutBody;
  try {
    body = await request.json() as PutBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { reportingCurrency } = body;

  if (typeof reportingCurrency !== "string" || !/^[A-Z]{3}$/.test(reportingCurrency)) {
    return new Response("Invalid reportingCurrency. Expected 3-letter ISO 4217 code", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    return Response.json({ reportingCurrency });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const updated = await updateReportCurrency(userId, workspaceId, reportingCurrency);
    return Response.json({ reportingCurrency: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database update failed: ${message}`, { status: 500 });
  }
};
