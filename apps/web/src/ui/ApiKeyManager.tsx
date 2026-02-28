"use client";

import { type ReactElement, useCallback, useState } from "react";

import type { ApiKeyRow } from "@/server/apiKeys";

type Props = Readonly<{
  initialKeys: ReadonlyArray<ApiKeyRow>;
}>;

type CreatedKey = Readonly<{
  id: string;
  key: string;
  keyPrefix: string;
}>;

const formatCurlExample = (key: string): string =>
  `curl -X POST https://YOUR_DOMAIN/api/sql \\
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

  const handleCreate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/api-keys", {
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
      const response = await fetch("/api/api-keys", {
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
    <div className="settings-form">
      {/* Key just created — show-once display */}
      {createdKey !== null && (
        <>
          <p className="settings-warning">
            Copy the API key now — it will not be shown again.
          </p>
          <div className="settings-codeblock">
            <button
              className="settings-codeblock-copy"
              type="button"
              onClick={handleCopy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <pre>{createdKey.key}</pre>
          </div>
          <details>
            <summary>Example curl command</summary>
            <div className="settings-codeblock">
              <pre>{formatCurlExample(createdKey.key)}</pre>
            </div>
          </details>
        </>
      )}

      {/* Create new key */}
      <div className="settings-control">
        <input
          type="text"
          className="settings-input"
          placeholder="Label (optional, e.g. Claude Code agent)"
          value={label}
          onChange={(e) => { setLabel(e.target.value); }}
          maxLength={200}
        />
        <button
          className="settings-save"
          type="button"
          onClick={handleCreate}
          disabled={loading}
        >
          {loading ? "Generating..." : "Generate API key"}
        </button>
      </div>

      {/* Key list */}
      {keys.length > 0 && (
        <table className="settings-table">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td><code>{k.keyPrefix}...</code></td>
                <td>{k.label || "—"}</td>
                <td>{formatDate(k.createdAt)}</td>
                <td>{k.lastUsedAt !== null ? formatDate(k.lastUsedAt) : "Never"}</td>
                <td>
                  <button
                    className="settings-save settings-save--danger"
                    type="button"
                    onClick={() => { handleRevoke(k.id); }}
                    disabled={loading}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {keys.length === 0 && createdKey === null && (
        <p>Generate an API key to query the database via HTTP instead of direct Postgres access.</p>
      )}

      {error !== null && <div className="settings-error">{error}</div>}
    </div>
  );
};
