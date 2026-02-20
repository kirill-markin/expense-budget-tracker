import { query } from "@/server/db";

type InsertBudgetCommentParams = Readonly<{
  month: string;
  direction: string;
  category: string;
  comment: string;
}>;

export const insertBudgetComment = async (params: InsertBudgetCommentParams): Promise<void> => {
  await query(
    `INSERT INTO budget_comments (budget_month, direction, category, comment)
     VALUES (to_date($1, 'YYYY-MM'), $2, $3, $4)`,
    [params.month, params.direction, params.category, params.comment],
  );
};
