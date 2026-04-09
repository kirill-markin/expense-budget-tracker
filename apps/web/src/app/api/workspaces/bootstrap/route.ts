import { NextResponse } from "next/server";

import { buildRequestIdentity } from "@/server/db/requestIdentity";
import { resolveWorkspaceForCurrentRequestIdentity } from "@/server/workspaceBootstrap";

const WORKSPACE_COOKIE_NAME = "workspace";
const WORKSPACE_BOOTSTRAP_PATH = "/api/workspaces/bootstrap";

type BootstrapRouteDependencies = Readonly<{
  resolveWorkspaceForIdentity: typeof resolveWorkspaceForCurrentRequestIdentity;
}>;

const DEFAULT_BOOTSTRAP_ROUTE_DEPENDENCIES: BootstrapRouteDependencies = {
  resolveWorkspaceForIdentity: resolveWorkspaceForCurrentRequestIdentity,
};

const createSameOriginRedirectResponse = (location: string): NextResponse => {
  // Route handlers may observe an internal container URL behind proxies/load balancers.
  // A path-only Location header keeps this redirect on the current public origin.
  const response = new NextResponse(null, { status: 307 });
  response.headers.set("location", location);
  return response;
};

const sanitizeReturnTo = (rawValue: string | null): string => {
  if (rawValue === null || rawValue === "" || !rawValue.startsWith("/") || rawValue.startsWith("//")) {
    return "/";
  }

  return rawValue.startsWith(WORKSPACE_BOOTSTRAP_PATH) ? "/" : rawValue;
};

export const getWorkspaceBootstrapRouteWithDeps = async (
  request: Request,
  dependencies: BootstrapRouteDependencies,
): Promise<Response> => {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  const requestedWorkspaceId = request.headers.get("x-workspace-id") ?? "";
  const identity = buildRequestIdentity(request.headers);
  const workspace = await dependencies.resolveWorkspaceForIdentity(identity, requestedWorkspaceId);

  const response = createSameOriginRedirectResponse(returnTo);
  response.cookies.set({
    name: WORKSPACE_COOKIE_NAME,
    value: workspace.workspaceId,
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
    secure: true,
  });
  return response;
};

export const GET = async (request: Request): Promise<Response> =>
  getWorkspaceBootstrapRouteWithDeps(request, DEFAULT_BOOTSTRAP_ROUTE_DEPENDENCIES);
