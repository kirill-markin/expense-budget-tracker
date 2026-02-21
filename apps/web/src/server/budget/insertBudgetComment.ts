/**
 * Append a comment to a budget cell.
 *
 * Comments are append-only (same pattern as budget_lines). The latest
 * non-empty comment per (month, direction, category) is the effective one.
 */
import { queryAs } from "@/server/db";

type InsertBudgetCommentParams = Readonly<{
  month: string;
  direction: string;
  category: string;
  comment: string;
}>;

export const insertBudgetComment = async (userId: string, workspaceId: string, params: InsertBudgetCommentParams): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    `INSERT INTO budget_comments (workspace_id, budget_month, direction, category, comment)
     VALUES ($1, to_date($2, 'YYYY-MM'), $3, $4, $5)`,
    [workspaceId, params.month, params.direction, params.category, params.comment],
  );
};
