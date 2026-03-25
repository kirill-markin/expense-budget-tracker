/**
 * Browser fetch wrapper for live workspace data.
 *
 * Route refresh only re-runs rendering and client-side effects. The follow-up
 * reads still need to bypass browser/Next fetch caches so dashboards and
 * tables reflect the newest committed data without requiring a manual reload.
 *
 * Server-rendered pages issue a fresh `refreshToken` after a chat-driven route
 * refresh. Live widgets append that token to their read URLs so the first read
 * after the refresh is observably distinct from the stale pre-refresh read.
 */

type LiveDataFetchInit = Omit<RequestInit, "cache">;

/**
 * Builds a live-data URL that is tied to a specific route refresh boundary.
 *
 * The refresh token is an internal UI synchronization marker. It is not part
 * of the business payload, but it ensures that client-side live reads track
 * the same post-refresh snapshot as the surrounding server component props.
 */
export const buildLiveDataUrl = (
  path: string,
  params: URLSearchParams,
  refreshToken: string,
): string => {
  const nextParams = new URLSearchParams(params.toString());
  nextParams.set("refresh", refreshToken);
  return `${path}?${nextParams.toString()}`;
};

export const fetchLiveData = (
  input: string | URL | Request,
  init?: LiveDataFetchInit,
): Promise<Response> =>
  fetch(input, {
    ...init,
    cache: "no-store",
  });
