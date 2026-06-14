export type PublicMonthlyShareAccessLevel = "category_only" | "monthly_values";

export type PublicMonthlyShareCategory = Readonly<{
  category: string;
  accessLevel: PublicMonthlyShareAccessLevel;
}>;

export type PublicMonthlyShareCell = Readonly<{
  month: string;
  category: string;
  amount: number;
}>;

export type PublicMonthlyShareYearTotal = Readonly<{
  year: string;
  category: string;
  amount: number;
}>;

export type PublicMonthlyCategoryShare = Readonly<{
  label: string;
  currency: string;
  availableMonthFrom: string | null;
  availableMonthTo: string | null;
  loadedMonthFrom: string | null;
  loadedMonthTo: string | null;
  categories: ReadonlyArray<PublicMonthlyShareCategory>;
  cells: ReadonlyArray<PublicMonthlyShareCell>;
  yearTotals: ReadonlyArray<PublicMonthlyShareYearTotal>;
}>;
