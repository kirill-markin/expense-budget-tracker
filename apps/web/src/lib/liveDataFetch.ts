/**
 * Browser fetch wrapper for live workspace data.
 *
 * Route refresh only re-runs rendering and client-side effects. The follow-up
 * reads still need to bypass browser/Next fetch caches so dashboards and
 * tables reflect the newest committed data without requiring a manual reload.
 */

type LiveDataFetchInit = Omit<RequestInit, "cache">;

export const fetchLiveData = (
  input: string | URL | Request,
  init?: LiveDataFetchInit,
): Promise<Response> =>
  fetch(input, {
    ...init,
    cache: "no-store",
  });
