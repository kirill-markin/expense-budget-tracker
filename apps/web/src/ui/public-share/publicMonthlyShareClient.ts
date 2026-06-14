import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";
import type { PublicMonthlyShareWindow } from "@/ui/public-share/publicMonthlyShareModel";

export const buildPublicMonthlyShareJsonHref = (
  token: string,
  window: PublicMonthlyShareWindow,
): string => {
  const params = new URLSearchParams({
    monthFrom: window.monthFrom,
    monthTo: window.monthTo,
  });
  return `/api/share/monthly/${encodeURIComponent(token)}?${params.toString()}`;
};

export const fetchPublicMonthlyShareWindow = async (
  token: string,
  window: PublicMonthlyShareWindow,
): Promise<PublicMonthlyCategoryShare> => {
  const url = buildPublicMonthlyShareJsonHref(token, window);
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Public monthly share fetch failed: status=${response.status} body=${await response.text()} monthFrom=${window.monthFrom} monthTo=${window.monthTo} tokenLength=${token.length}`,
    );
  }
  return response.json() as Promise<PublicMonthlyCategoryShare>;
};
