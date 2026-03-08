"use client";

import { type ReactElement, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import type { ApiKeyRow } from "@/server/apiKeys";

import settingsStyles from "@/ui/SettingsForm.module.css";

type Props = Readonly<{
  initialKeys: ReadonlyArray<ApiKeyRow>;
}>;

type CreatedKey = Readonly<{
  id: string;
  key: string;
  keyPrefix: string;
}>;

const formatCurlExample = (key: string): string =>
  `curl -X POST https://api.YOUR_DOMAIN/v1/sql \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"sql": "SELECT * FROM ledger_entries ORDER BY ts DESC LIMIT 10"}'`;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export const ApiKeyManager = (props: Props): ReactElement => {
  const [keys, setKeys] = useState<ReadonlyArray<ApiKeyRow>>(props.initialKeys);
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [label, setLabel] = useState<string>("");
  const { t } = useTranslation();

  const handleCreate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithCsrf("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }
      const data = (await response.json()) as CreatedKey;
      setCreatedKey(data);
      setLabel("");
      // Refresh the list.
      const listResponse = await fetch("/api/api-keys");
      if (listResponse.ok) {
        const listData = (await listResponse.json()) as { keys: ReadonlyArray<ApiKeyRow> };
        setKeys(listData.keys);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [label]);

  const handleRevoke = useCallback(async (keyId: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithCsrf("/api/api-keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: keyId }),
      });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== keyId));
      if (createdKey !== null && createdKey.id === keyId) {
        setCreatedKey(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [createdKey]);

  const handleCopy = useCallback((): void => {
    if (createdKey === null) return;
    navigator.clipboard.writeText(createdKey.key).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  }, [createdKey]);

  return (
    <div className={settingsStyles.form}>
      {/* Key just created — show-once display */}
      {createdKey !== null && (
        <>
          <p className={settingsStyles.warning}>
            {t("apiKeys.copyWarning")}
          </p>
          <div className={settingsStyles.codeblock}>
            <button
              className={settingsStyles.codeblockCopy}
              type="button"
              onClick={handleCopy}
            >
              {copied ? t("apiKeys.copied") : t("apiKeys.copy")}
            </button>
            <pre>{createdKey.key}</pre>
          </div>
          <details>
            <summary>{t("apiKeys.exampleCurl")}</summary>
            <div className={settingsStyles.codeblock}>
              <pre>{formatCurlExample(createdKey.key)}</pre>
            </div>
          </details>
        </>
      )}

      {/* Create new key */}
      <div className={settingsStyles.control}>
        <input
          type="text"
          className={settingsStyles.input}
          placeholder={t("apiKeys.labelPlaceholder")}
          value={label}
          onChange={(e) => { setLabel(e.target.value); }}
          maxLength={200}
        />
        <button
          className={settingsStyles.save}
          type="button"
          onClick={handleCreate}
          disabled={loading}
        >
          {loading ? t("apiKeys.generating") : t("apiKeys.generate")}
        </button>
      </div>

      {/* Key list */}
      {keys.length > 0 && (
        <table className={settingsStyles.table}>
          <thead>
            <tr>
              <th>{t("apiKeys.prefix")}</th>
              <th>{t("apiKeys.label")}</th>
              <th>{t("apiKeys.created")}</th>
              <th>{t("apiKeys.lastUsed")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td><code>{k.keyPrefix}...</code></td>
                <td>{k.label || "\u2014"}</td>
                <td>{formatDate(k.createdAt)}</td>
                <td>{k.lastUsedAt !== null ? formatDate(k.lastUsedAt) : t("apiKeys.never")}</td>
                <td>
                  <button
                    className={cn(settingsStyles.save, settingsStyles.saveDanger)}
                    type="button"
                    onClick={() => { handleRevoke(k.id); }}
                    disabled={loading}
                  >
                    {t("apiKeys.revoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {keys.length === 0 && createdKey === null && (
        <p>{t("apiKeys.emptyState")}</p>
      )}

      {error !== null && <div className={settingsStyles.error}>{error}</div>}
    </div>
  );
};
