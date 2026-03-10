"use client";

import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import type { AgentConnectionRow } from "@/server/agentConnections";

import settingsStyles from "@/ui/SettingsForm.module.css";

const MACHINE_API_BASE_URL = "https://api.expense-budget-tracker.com/v1";
const MACHINE_API_DISCOVERY_URL = `${MACHINE_API_BASE_URL}/`;
const MACHINE_API_OPENAPI_URL = `${MACHINE_API_BASE_URL}/openapi.json`;
const COPY_FEEDBACK_MS = 1500;

type AccessCardId = "agent" | "program";

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
  {
    id: "program",
    titleKey: "agentAccess.programTitle",
    descriptionKey: "agentAccess.programDescription",
    linkKey: "agentAccess.openapiLink",
    href: MACHINE_API_OPENAPI_URL,
    snippet: `GET ${MACHINE_API_OPENAPI_URL}
Authenticated requests use Authorization: ApiKey <key>.`,
  },
];

type Props = Readonly<{
  initialConnections: ReadonlyArray<AgentConnectionRow>;
}>;

const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export const AgentConnectionsManager = (props: Props): ReactElement => {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<ReadonlyArray<AgentConnectionRow>>(props.initialConnections);
  const [loadingConnectionId, setLoadingConnectionId] = useState<string | null>(null);
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

  const handleRevoke = async (connectionId: string): Promise<void> => {
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
                  <th>{t("apiKeys.created")}</th>
                  <th>{t("apiKeys.lastUsed")}</th>
                  <th>{t("agentAccess.status")}</th>
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
                      <td>{connection.lastUsedAt !== null ? formatDate(connection.lastUsedAt) : t("apiKeys.never")}</td>
                      <td>{isRevoked ? t("agentAccess.statusRevoked") : t("agentAccess.statusActive")}</td>
                      <td>
                        {!isRevoked && (
                          <button
                            className={cn(settingsStyles.save, settingsStyles.saveDanger)}
                            type="button"
                            onClick={() => { void handleRevoke(connection.connectionId); }}
                            disabled={loadingConnectionId === connection.connectionId}
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
