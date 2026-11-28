import { parseSupportedLocale, type SupportedLocale } from "@expense-budget-tracker/agent-shared/locales";

import { NAV_LINKS } from "@/lib/navigation";

export const parseLocaleHint = (searchParams: Pick<URLSearchParams, "get">): SupportedLocale | null =>
  parseSupportedLocale(searchParams.get("locale"));

export const reloadWithoutLocaleHint = (url: URL): void => {
  if (url.searchParams.has("locale")) {
    url.searchParams.delete("locale");
    window.history.replaceState(window.history.state, "", url);
  }
  window.location.reload();
};

export const withDemoLocaleHint = (
  href: string,
  searchParams: Pick<URLSearchParams, "get"> | null,
): string => {
  if (searchParams === null) return href;
  const locale = parseLocaleHint(searchParams);
  if (locale === null) return href;

  const [pathname] = href.split(/[?#]/u, 1);
  if (pathname !== "/" && !NAV_LINKS.some((link) => link.href === pathname)) return href;

  const url = new URL(href, "https://app.invalid");
  url.searchParams.set("locale", locale);
  return `${url.pathname}${url.search}${url.hash}`;
};
