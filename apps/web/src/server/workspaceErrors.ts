export const ACTIVE_WORKSPACE_RELOAD_MESSAGE = "Active workspace is unavailable. Reload to re-establish workspace context.";

export class WorkspaceAccessError extends Error {
  public readonly userId: string;
  public readonly workspaceId: string;

  public constructor(userId: string, workspaceId: string) {
    super(`User ${userId} is not a member of workspace ${workspaceId}`);
    this.name = "WorkspaceAccessError";
    this.userId = userId;
    this.workspaceId = workspaceId;
  }
}
