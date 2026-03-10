"use client";

import { type ReactElement, useCallback, useState } from "react";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import type { AgentConnectionRow } from "@/server/agentConnections";

import settingsStyles from "@/ui/SettingsForm.module.css";

type Props = Readonly<{
  initialConnections: ReadonlyArray<AgentConnectionRow>;
}>;

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export const AgentConnectionsManager = (props: Props): ReactElement => {
  const [connections, setConnections] = useState<ReadonlyArray<AgentConnectionRow>>(props.initialConnections);
  const [loadingConnectionId, setLoadingConnectionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRevoke = useCallback(async (connectionId: string): Promise<void> => {
    setLoadingConnectionId(connectionId);
    setError(null);

    try {
      const response = await fetchWithCsrf(`/api/agent-connections/${connectionId}/revoke`, {
        method: "POST",
      });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }

      setConnections((prev) => prev.map((connection) => (
        connection.connectionId === connectionId
          ? { ...connection, revokedAt: connection.revokedAt ?? new Date().toISOString() }
          : connection
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingConnectionId(null);
    }
  }, []);

  return (
    <div className={settingsStyles.form}>
      {connections.length > 0 ? (
        <table className={settingsStyles.table}>
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => {
              const isRevoked = connection.revokedAt !== null;
              return (
                <tr key={connection.connectionId}>
                  <td>{connection.label}</td>
                  <td>{formatDate(connection.createdAt)}</td>
                  <td>{connection.lastUsedAt !== null ? formatDate(connection.lastUsedAt) : "Never"}</td>
                  <td>{isRevoked ? "Revoked" : "Active"}</td>
                  <td>
                    {!isRevoked && (
                      <button
                        className={cn(settingsStyles.save, settingsStyles.saveDanger)}
                        type="button"
                        onClick={() => { handleRevoke(connection.connectionId); }}
                        disabled={loadingConnectionId === connection.connectionId}
                      >
                        {loadingConnectionId === connection.connectionId ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p>No agent connections yet.</p>
      )}

      {error !== null && <div className={settingsStyles.error}>{error}</div>}
    </div>
  );
};
