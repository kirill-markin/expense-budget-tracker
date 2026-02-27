export const formatAmount = (value: number): string => {
  if (value === 0) return "0";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const formatDateTime = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    + " " + date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
};

export const sortIndicator = (active: boolean, dir: "asc" | "desc", position?: number): string => {
  if (!active) return "";
  const arrow = dir === "asc" ? "\u2191" : "\u2193";
  if (position !== undefined && position > 1) return ` ${position}${arrow}`;
  return ` ${arrow}`;
};
