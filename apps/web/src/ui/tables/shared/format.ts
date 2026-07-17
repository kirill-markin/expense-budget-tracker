import type { NumberFormat, DateFormat } from "@/lib/locale";

type NumberFormatSeparators = Readonly<{
  group: string;
  decimal: string;
}>;

export type FormatNumberOptions = Readonly<{
  minimumFractionDigits: number;
  maximumFractionDigits: number;
}>;

const NUMBER_FORMAT_SEPARATORS: Readonly<Record<NumberFormat, NumberFormatSeparators>> = {
  "1,234.56": { group: ",", decimal: "." },
  "1 234,56": { group: "\u00a0", decimal: "," },
  "1.234,56": { group: ".", decimal: "," },
  "1 234.56": { group: " ", decimal: "." },
};

export const formatNumber = (
  value: number,
  numberFormat: NumberFormat,
  options: FormatNumberOptions,
): string => {
  const separators = NUMBER_FORMAT_SEPARATORS[numberFormat];
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
  });
  return formatter.formatToParts(value).map((part): string => {
    if (part.type === "group") return separators.group;
    if (part.type === "decimal") return separators.decimal;
    return part.value;
  }).join("");
};

export const formatAmount = (value: number, numberFormat: NumberFormat): string => {
  if (value === 0) return "0";
  return formatNumber(value, numberFormat, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const formatDateTime = (isoString: string, dateFormat: DateFormat): string => {
  const date = new Date(isoString);
  switch (dateFormat) {
    case "DD.MM.YYYY": {
      const d = String(date.getDate()).padStart(2, "0");
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const y = date.getFullYear();
      const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
      return `${d}.${m}.${y} ${time}`;
    }
    case "MM/DD/YYYY": {
      const d = String(date.getDate()).padStart(2, "0");
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const y = date.getFullYear();
      const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      return `${m}/${d}/${y} ${time}`;
    }
    case "YYYY-MM-DD": {
      const d = String(date.getDate()).padStart(2, "0");
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const y = date.getFullYear();
      const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
      return `${y}-${m}-${d} ${time}`;
    }
  }
};

export const sortIndicator = (active: boolean, dir: "asc" | "desc", position?: number): string => {
  if (!active) return "";
  const arrow = dir === "asc" ? "\u2191" : "\u2193";
  if (position !== undefined && position > 1) return ` ${position}${arrow}`;
  return ` ${arrow}`;
};
