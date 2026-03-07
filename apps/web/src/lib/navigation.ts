type NavHref = "/budget" | "/transactions" | "/balances" | "/dashboards" | "/chat" | "/settings";

type NavLabelKey =
  | "nav.budget"
  | "nav.transactions"
  | "nav.balances"
  | "nav.dashboards"
  | "nav.chat"
  | "nav.settings";

export type NavLink = Readonly<{
  href: NavHref;
  labelKey: NavLabelKey;
}>;

export const NAV_LINKS: ReadonlyArray<NavLink> = [
  { href: "/budget", labelKey: "nav.budget" },
  { href: "/transactions", labelKey: "nav.transactions" },
  { href: "/balances", labelKey: "nav.balances" },
  { href: "/dashboards", labelKey: "nav.dashboards" },
  { href: "/chat", labelKey: "nav.chat" },
  { href: "/settings", labelKey: "nav.settings" },
];
