import { NextResponse } from "next/server";

import { appLocaleSetCookie, getInitialLocale, readAppLocaleCookie } from "@/lib/localeCookie";
import { buildRequestIdentity } from "@/server/db/requestIdentity";
import { getUserSettings } from "@/server/userSettings";
import { resolveWorkspaceForCurrentRequestIdentity } from "@/server/workspaceBootstrap";

const WORKSPACE_COOKIE_NAME = "workspace";
const WORKSPACE_BOOTSTRAP_PATH = "/api/workspaces/bootstrap";
const RETURN_PATH_ORIGIN = "https://app.invalid";

type BootstrapRouteDependencies = Readonly<{
  resolveWorkspaceForIdentity: typeof resolveWorkspaceForCurrentRequestIdentity;
  getUserSettings: typeof getUserSettings;
}>;

const DEFAULT_BOOTSTRAP_ROUTE_DEPENDENCIES: BootstrapRouteDependencies = {
  resolveWorkspaceForIdentity: resolveWorkspaceForCurrentRequestIdentity,
  getUserSettings,
};

const createSameOriginRedirectResponse = (location: string): NextResponse => {
  // Route handlers may observe an internal container URL behind proxies/load balancers.
  // A path-only Location header keeps this redirect on the current public origin.
  const response = new NextResponse(null, { status: 307 });
  response.headers.set("location", location);
  return response;
};

const sanitizeReturnTo = (rawValue: string | null): string => {
  if (rawValue === null || !rawValue.startsWith("/") || rawValue.startsWith("//")) return "/";
  const target = URL.parse(rawValue, RETURN_PATH_ORIGIN);
  if (target === null || target.origin !== RETURN_PATH_ORIGIN || target.pathname.startsWith(WORKSPACE_BOOTSTRAP_PATH)) {
    return "/";
  }
  const path = target.pathname + target.search + target.hash;
  return path.startsWith("//") ? "/" : path;
};

export const getWorkspaceBootstrapRouteWithDeps = async (
  request: Request,
  dependencies: BootstrapRouteDependencies,
): Promise<Response> => {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));
  const requestedWorkspaceId = request.headers.get("x-workspace-id") ?? "";
  const identity = buildRequestIdentity(request.headers);
  const initialLocale = getInitialLocale(request.headers, returnTo);
  const workspace = await dependencies.resolveWorkspaceForIdentity(identity, requestedWorkspaceId, initialLocale);
  const { locale } = await dependencies.getUserSettings(identity.userId, workspace.workspaceId, initialLocale);

  const response = createSameOriginRedirectResponse(returnTo);
  response.cookies.set({
    name: WORKSPACE_COOKIE_NAME,
    value: workspace.workspaceId,
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
    secure: true,
  });
  if (readAppLocaleCookie(request.headers) !== locale) {
    response.headers.append("Set-Cookie", appLocaleSetCookie(locale));
  }
  return response;
};

export const GET = async (request: Request): Promise<Response> =>
  getWorkspaceBootstrapRouteWithDeps(request, DEFAULT_BOOTSTRAP_ROUTE_DEPENDENCIES);
