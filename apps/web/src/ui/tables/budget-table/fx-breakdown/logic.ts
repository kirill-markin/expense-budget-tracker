import { getMonthEndDate } from "@/lib/monthUtils";

type FxAdjustSummaryRow = Readonly<{
  fxAdjustReport: number;
}>;

export const sumFxAdjustReport = (rows: ReadonlyArray<FxAdjustSummaryRow>): number =>
  rows.reduce((sum, row) => sum + row.fxAdjustReport, 0);

export const buildFxBreakdownSubtitle = (month: string, closeValuationDate: string): string =>
  closeValuationDate === getMonthEndDate(month) ? month : `${month} · FX as of ${closeValuationDate}`;
