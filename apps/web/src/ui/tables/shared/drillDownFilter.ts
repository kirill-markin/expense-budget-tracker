export type DrillDownFilter = Readonly<{
  dateFrom: string;
  dateTo: string;
  direction: string | null;
  category: string | null;
  categories: ReadonlyArray<string> | null;
  businessPersonalTransfers: boolean;
}>;
