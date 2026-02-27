/**
 * Per-workspace filtered categories resolver.
 *
 * Reads/writes workspace_settings.filtered_categories for the given workspace.
 * NULL means no filter configured (show everything).
 * Empty array means filter active but nothing selected (mask everything).
 */
import { queryAs } from "@/server/db";

type FilteredCategoriesRow = Readonly<{
  filtered_categories: ReadonlyArray<string> | null;
}>;

/** Returns the filtered categories list, or null if not configured. */
export const getFilteredCategories = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<string> | null> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT filtered_categories FROM workspace_settings WHERE workspace_id = $1",
    [workspaceId],
  );
  if (result.rows.length === 0) {
    throw new Error(`workspace_settings row missing for workspace ${workspaceId}`);
  }
  return (result.rows[0] as FilteredCategoriesRow).filtered_categories;
};

/** Updates filtered categories and returns the stored value. */
export const updateFilteredCategories = async (
  userId: string,
  workspaceId: string,
  categories: ReadonlyArray<string> | null,
): Promise<ReadonlyArray<string> | null> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "UPDATE workspace_settings SET filtered_categories = $2 WHERE workspace_id = $1 RETURNING filtered_categories",
    [workspaceId, categories],
  );
  if (result.rows.length === 0) {
    throw new Error(`workspace_settings row missing for workspace ${workspaceId}`);
  }
  return (result.rows[0] as FilteredCategoriesRow).filtered_categories;
};
