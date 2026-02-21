import { queryAs } from "@/server/db";

export type CommentedCell = Readonly<{
  month: string;
  direction: string;
  category: string;
}>;

type GetCommentedCellsParams = Readonly<{
  monthFrom: string;
  monthTo: string;
}>;

/**
 * Returns all (month, direction, category) tuples within the given range
 * where the most recent comment is non-empty.
 */
export const getCommentedCells = async (userId: string, params: GetCommentedCellsParams): Promise<ReadonlyArray<CommentedCell>> => {
  const result = await queryAs(
    userId,
    `WITH latest AS (
       SELECT
         budget_month, direction, category, comment,
         ROW_NUMBER() OVER (
           PARTITION BY budget_month, direction, category
           ORDER BY inserted_at DESC
         ) AS rn
       FROM budget_comments
       WHERE budget_month BETWEEN to_date($1, 'YYYY-MM')
                               AND to_date($2, 'YYYY-MM')
     )
     SELECT
       to_char(budget_month, 'YYYY-MM') AS month,
       direction,
       category
     FROM latest
     WHERE rn = 1
       AND comment IS NOT NULL
       AND TRIM(comment) != ''`,
    [params.monthFrom, params.monthTo],
  );

  return result.rows.map((row: { month: string; direction: string; category: string }) => ({
    month: row.month,
    direction: row.direction,
    category: row.category,
  }));
};
