/**
 * Shared cache policy for live workspace data.
 *
 * Financial dashboards, transactions, drill-downs, and related overlays are
 * mutation-sensitive and must always reflect the latest committed workspace
 * state. These helpers disable browser, intermediary, and app-layer caching
 * for JSON responses that back those live views.
 */

export const applyNoStoreHeaders = (
  headers?: HeadersInit,
): Headers => {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store, no-cache, must-revalidate");
  result.set("Pragma", "no-cache");
  result.set("Expires", "0");
  return result;
};

export const jsonNoStore = (
  body: unknown,
  init?: ResponseInit,
): Response =>
  Response.json(body, {
    ...init,
    headers: applyNoStoreHeaders(init?.headers),
  });
