"use client";

import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react";

type WorkspaceSummary = Readonly<{
  workspaceId: string;
  name: string;
}>;

type Props = Readonly<{
  authEnabled: boolean;
  workspaces: ReadonlyArray<WorkspaceSummary>;
  currentWorkspaceId: string;
}>;

export const AccountMenu = (props: Props): ReactElement | null => {
  const { authEnabled, workspaces, currentWorkspaceId } = props;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback((): void => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        menuRef.current !== null && !menuRef.current.contains(target) &&
        buttonRef.current !== null && !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
        setIsCreating(false);
        setNewName("");
        setError("");
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setIsCreating(false);
        setNewName("");
        setError("");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isCreating && inputRef.current !== null) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  useEffect(() => {
    if (!authEnabled || currentWorkspaceId === "") return;
    const match = document.cookie.match(/(?:^|;\s*)workspace=([^;]*)/);
    const cookieValue = match ? decodeURIComponent(match[1]) : "";
    if (cookieValue !== "" && cookieValue !== currentWorkspaceId) {
      document.cookie = `workspace=${currentWorkspaceId};path=/;max-age=31536000;samesite=lax`;
    }
  }, [authEnabled, currentWorkspaceId]);

  const handleSwitch = useCallback((workspaceId: string): void => {
    document.cookie = `workspace=${workspaceId};path=/;max-age=31536000;samesite=lax`;
    window.location.reload();
  }, []);

  const handleLogout = useCallback((): void => {
    window.location.href = "/api/auth/logout";
  }, []);

  const handleCreate = useCallback(async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (trimmed.length === 0) return;

    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }

      const data = await response.json() as { workspaceId: string };
      document.cookie = `workspace=${data.workspaceId};path=/;max-age=31536000;samesite=lax`;
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [newName]);

  if (!authEnabled) return null;

  return (
    <div className="account-menu-wrap">
      <button
        ref={buttonRef}
        className="account-menu-btn"
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M20 21a8 8 0 0 0-16 0" /></svg>
      </button>
      {isOpen && (
        <div ref={menuRef} className="account-menu-dropdown">
          {workspaces.length > 0 && (
            <>
              <div className="account-menu-section-label">Workspaces</div>
              {workspaces.map((ws) => (
                <button
                  key={ws.workspaceId}
                  className={`account-menu-item${ws.workspaceId === currentWorkspaceId ? " account-menu-item-active" : ""}`}
                  type="button"
                  onClick={() => handleSwitch(ws.workspaceId)}
                >
                  {ws.name}
                </button>
              ))}
            </>
          )}
          {!isCreating && (
            <button
              className="account-menu-item account-menu-item-create"
              type="button"
              onClick={() => setIsCreating(true)}
            >
              + New workspace
            </button>
          )}
          {isCreating && (
            <form className="account-menu-create-form" onSubmit={handleCreate}>
              <input
                ref={inputRef}
                className="account-menu-create-input"
                type="text"
                placeholder="Workspace name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={submitting}
              />
              {error !== "" && <div className="account-menu-error">{error}</div>}
            </form>
          )}
          <div className="account-menu-separator" />
          <button
            className="account-menu-item"
            type="button"
            onClick={() => { window.location.href = "/account/mfa"; }}
          >
            Two-Factor Auth
          </button>
          <div className="account-menu-separator" />
          <button
            className="account-menu-item"
            type="button"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
};
