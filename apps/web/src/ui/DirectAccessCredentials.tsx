"use client";

import { type ReactElement, useCallback, useState } from "react";

import type { DirectAccessCredentials as Credentials } from "@/server/directAccess";

type Props = Readonly<{
  initialCredentials: Credentials | null;
}>;

const formatCredentials = (c: Credentials): string => {
  const pw = c.password ?? "●●●●●●●●";
  const connStr = c.password !== null
    ? `postgresql://${c.username}:${c.password}@${c.host}:${c.port}/${c.database}?sslmode=${c.sslmode}`
    : `postgresql://${c.username}:<password>@${c.host}:${c.port}/${c.database}?sslmode=${c.sslmode}`;
  return `Host: ${c.host}\nPort: ${c.port}\nDatabase: ${c.database}\nUsername: ${c.username}\nPassword: ${pw}\nSSL: ${c.sslmode}\n\n# Connection string\n${connStr}`;
};

export const DirectAccessCredentials = (props: Props): ReactElement => {
  const [credentials, setCredentials] = useState<Credentials | null>(props.initialCredentials);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const passwordVisible = credentials !== null && credentials.password !== null;

  const handleProvision = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/direct-access", { method: "POST" });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }
      const data = (await response.json()) as { credentials: Credentials };
      setCredentials(data.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRevoke = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/direct-access", { method: "DELETE" });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }
      setCredentials(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRotate = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/direct-access", { method: "PUT" });
      if (!response.ok) {
        const text = await response.text();
        setError(text);
        return;
      }
      const data = (await response.json()) as { credentials: Credentials };
      setCredentials(data.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCopy = useCallback((): void => {
    if (credentials === null) return;
    navigator.clipboard.writeText(formatCredentials(credentials)).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  }, [credentials]);

  // State 1: not provisioned
  if (credentials === null) {
    return (
      <div className="settings-form">
        <p>Generate credentials to connect directly to the database with psql, DBeaver, or LLM agents.</p>
        <button
          className="settings-save"
          type="button"
          onClick={handleProvision}
          disabled={loading}
        >
          {loading ? "Generating..." : "Generate credentials"}
        </button>
        {error !== null && <div className="settings-error">{error}</div>}
      </div>
    );
  }

  // State 2: provisioned, password just shown (after provision or rotate)
  // State 3: provisioned, password hidden (page load or already copied)
  return (
    <div className="settings-form">
      {passwordVisible && (
        <p className="settings-warning">
          Copy the password now — it will not be shown again.
        </p>
      )}
      <div className="settings-codeblock">
        <button
          className="settings-codeblock-copy"
          type="button"
          onClick={handleCopy}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <pre>{formatCredentials(credentials)}</pre>
      </div>
      <div className="settings-control">
        <button
          className="settings-save"
          type="button"
          onClick={handleRotate}
          disabled={loading}
        >
          {loading ? "Rotating..." : "Rotate password"}
        </button>
        <button
          className="settings-save settings-save--danger"
          type="button"
          onClick={handleRevoke}
          disabled={loading}
        >
          {loading ? "Revoking..." : "Revoke access"}
        </button>
      </div>
      {!passwordVisible && (
        <p className="settings-hint">
          Password was shown only at creation. Use &quot;Rotate password&quot; to generate a new one.
        </p>
      )}
      {error !== null && <div className="settings-error">{error}</div>}
    </div>
  );
};
