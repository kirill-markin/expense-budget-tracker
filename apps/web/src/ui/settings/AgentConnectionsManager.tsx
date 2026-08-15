"use client";

import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import type { AgentConnectionRow } from "@/server/agent/connections";

import settingsStyles from "./SettingsForm.module.css";

const MACHINE_API_BASE_URL = "https://api.expense-budget-tracker.com/v1";
const MACHINE_API_DISCOVERY_URL = `${MACHINE_API_BASE_URL}/`;
const COPY_FEEDBACK_MS = 1500;

type AccessCardId = "agent";

type AccessCard = Readonly<{
  id: AccessCardId;
  titleKey: string;
  descriptionKey: string;
  linkKey: string;
  href: string;
  snippet: string;
}>;

const ACCESS_CARDS: ReadonlyArray<AccessCard> = [
  {
    id: "agent",
    titleKey: "agentAccess.agentTitle",
    descriptionKey: "agentAccess.agentDescription",
    linkKey: "agentAccess.discoveryLink",
    href: MACHINE_API_DISCOVERY_URL,
    snippet: `Start with GET ${MACHINE_API_DISCOVERY_URL}
Follow the response instructions for signup, login, and workspace setup.`,
  },
];

type Props = Readonly<{
  initialConnections: ReadonlyArray<AgentConnectionRow>;
}>;

type ConnectionIdentity = Readonly<{
  type: AgentConnectionRow["type"];
  connectionId: string;
}>;

type RevokeConnectionResponse = Readonly<{
  revoked: boolean;
  instructions: string;
}>;

const parseRevokeConnectionResponse = (value: unknown): RevokeConnectionResponse => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent connection revocation returned an invalid response object.");
  }
  const response = value as Readonly<Record<string, unknown>>;
  if (typeof response["revoked"] !== "boolean" || typeof response["instructions"] !== "string") {
    throw new Error("Agent connection revocation response must include revoked and instructions.");
  }
  return {
    revoked: response["revoked"],
    instructions: response["instructions"],
  };
};

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export const AgentConnectionsManager = (props: Props): ReactElement => {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<ReadonlyArray<AgentConnectionRow>>(props.initialConnections);
  const [loadingConnection, setLoadingConnection] = useState<ConnectionIdentity | null>(null);
  const [copiedCardId, setCopiedCardId] = useState<AccessCardId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (cardId: AccessCardId, text: string): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCardId(cardId);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopiedCardId(null);
      }, COPY_FEEDBACK_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevoke = async (selectedConnection: AgentConnectionRow): Promise<void> => {
    const connectionId = selectedConnection.connectionId;
    setLoadingConnection({ type: selectedConnection.type, connectionId });
    setError(null);

    try {
      const response = await fetchWithCsrf(`/api/agent-connections/types/${selectedConnection.type}/${connectionId}/revoke`, {
        method: "POST",
      });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }
      const rawResponse: unknown = await response.json();
      const result = parseRevokeConnectionResponse(rawResponse);
      if (!result.revoked) {
        setError(result.instructions);
        return;
      }

      setConnections((prev) => prev.map((connection) => (
        connection.type === selectedConnection.type && connection.connectionId === connectionId
          ? { ...connection, revokedAt: connection.revokedAt ?? new Date().toISOString() }
          : connection
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingConnection(null);
    }
  };

  return (
    <div className={settingsStyles.form}>
      <div className={settingsStyles.accessGrid}>
        {ACCESS_CARDS.map((card) => (
          <section key={card.id} className={settingsStyles.accessCard}>
            <div className={settingsStyles.rowWide}>
              <h2 className={settingsStyles.accessTitle}>{t(card.titleKey)}</h2>
              <p className={settingsStyles.accessText}>{t(card.descriptionKey)}</p>
            </div>

            <div className={cn(settingsStyles.codeblock, settingsStyles.codeblockTight)}>
              <button
                className={settingsStyles.codeblockCopy}
                type="button"
                onClick={() => { void handleCopy(card.id, card.snippet); }}
              >
                {copiedCardId === card.id ? t("apiKeys.copied") : t("apiKeys.copy")}
              </button>
              <pre>{card.snippet}</pre>
            </div>

            <a className={settingsStyles.inlineLink} href={card.href} target="_blank" rel="noreferrer">
              {t(card.linkKey)}
            </a>
          </section>
        ))}
      </div>

      {connections.length > 0 && (
        <section className={settingsStyles.connectionsSection}>
          <h2 className={settingsStyles.accessTitle}>{t("agentAccess.connectionsTitle")}</h2>
          <div className={settingsStyles.tableWrap}>
            <table className={settingsStyles.table}>
              <thead>
                <tr>
                  <th>{t("apiKeys.label")}</th>
                  <th>{t("agentAccess.type")}</th>
                  <th>{t("apiKeys.created")}</th>
                  <th>{t("agentAccess.lastActivity")}</th>
                  <th>{t("agentAccess.status")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => {
                  const isRevoked = connection.revokedAt !== null;
                  const lastActivityAt = connection.type === "api_key"
                    ? connection.lastUsedAt
                    : connection.lastActivityAt;
                  return (
                    <tr key={`${connection.type}:${connection.connectionId}`}>
                      <td>{connection.label}</td>
                      <td>{connection.type === "api_key" ? t("agentAccess.typeApiKey") : t("agentAccess.typeOauth")}</td>
                      <td>{formatDate(connection.createdAt)}</td>
                      <td>{lastActivityAt !== null ? formatDate(lastActivityAt) : t("apiKeys.never")}</td>
                      <td>{isRevoked ? t("agentAccess.statusRevoked") : t("agentAccess.statusActive")}</td>
                      <td>
                        {!isRevoked && (
                          <button
                            className={cn(settingsStyles.save, settingsStyles.saveDanger)}
                            type="button"
                            onClick={() => { void handleRevoke(connection); }}
                            disabled={
                              loadingConnection?.type === connection.type
                              && loadingConnection.connectionId === connection.connectionId
                            }
                          >
                            {t("apiKeys.revoke")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {error !== null && <div className={settingsStyles.error}>{error}</div>}
    </div>
  );
};
