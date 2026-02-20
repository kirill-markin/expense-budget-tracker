import { query } from "@/server/db";

type GetLatestCommentParams = Readonly<{
  month: string;
  direction: string;
  category: string;
}>;

export const getLatestComment = async (params: GetLatestCommentParams): Promise<string | null> => {
  const result = await query(
    `SELECT comment
     FROM budget_comments
     WHERE budget_month = to_date($1, 'YYYY-MM')
       AND direction = $2
       AND category = $3
     ORDER BY inserted_at DESC
     LIMIT 1`,
    [params.month, params.direction, params.category],
  );

  if (result.rows.length === 0) return null;
  return (result.rows[0] as { comment: string }).comment;
};
