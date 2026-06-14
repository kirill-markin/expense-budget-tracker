export const MONTHLY_CATEGORY_SHARE_ACCESS_LEVELS = ["category_only", "monthly_values"] as const;
export type MonthlyCategoryShareAccessLevel = (typeof MONTHLY_CATEGORY_SHARE_ACCESS_LEVELS)[number];

export const MONTHLY_CATEGORY_SHARE_DIRECTIONS = ["spend"] as const;
export type MonthlyCategoryShareDirection = (typeof MONTHLY_CATEGORY_SHARE_DIRECTIONS)[number];

export type MonthlyCategoryShareSettings = Readonly<{
  enabled: boolean;
  indexingEnabled: boolean;
  displayLabel: string;
  monthFrom: string | null;
  monthTo: string | null;
}>;

export type MonthlyCategoryShareItem = Readonly<{
  direction: MonthlyCategoryShareDirection;
  category: string;
  accessLevel: MonthlyCategoryShareAccessLevel;
}>;

export type MonthlyCategoryShareSettingsResponse = Readonly<{
  settings: MonthlyCategoryShareSettings;
  dashboardUrl: string | null;
  jsonUrl: string | null;
  selectedItems: ReadonlyArray<MonthlyCategoryShareItem>;
  availableSpendCategories: ReadonlyArray<string>;
}>;

export type MonthlyCategoryShareSettingsPatch = Readonly<{
  displayLabel?: string;
  monthFrom?: string | null;
  monthTo?: string | null;
  hasDisplayLabel: boolean;
  hasMonthFrom: boolean;
  hasMonthTo: boolean;
}>;

export type MonthlyCategoryShareIndexingUpdate = Readonly<{
  indexingEnabled: boolean;
}>;
