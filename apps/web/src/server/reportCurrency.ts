import { query } from "@/server/db";

export const getReportCurrency = async (): Promise<string> => {
  const result = await query(
    "SELECT reporting_currency FROM workspace_settings WHERE id = 1",
    [],
  );
  return (result.rows[0] as { reporting_currency: string }).reporting_currency;
};
