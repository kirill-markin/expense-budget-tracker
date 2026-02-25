"use client";

import { type ReactElement, useCallback, useState } from "react";

import type { DirectAccessCredentials as Credentials } from "@/server/directAccess";

type Props = Readonly<{
  initialCredentials: Credentials | null;
}>;

const formatCredentials = (c: Credentials): string =>
  `Host: ${c.host}\nPort: ${c.port}\nDatabase: ${c.database}\nUsername: ${c.username}\nPassword: ${c.password}\nSSL: ${c.sslmode}\n\n# Connection string\npostgresql://${c.username}:${c.password}@${c.host}:${c.port}/${c.database}?sslmode=${c.sslmode}`;

export const DirectAccessCredentials = (props: Props): ReactElement => {
  const [credentials, setCredentials] = useState<Credentials | null>(props.initialCredentials);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

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

  return (
    <div className="settings-form">
      <textarea
        className="settings-textarea"
        readOnly
        rows={9}
        value={formatCredentials(credentials)}
      />
      <div className="settings-control">
        <button
          className="settings-save"
          type="button"
          onClick={handleCopy}
          disabled={loading}
        >
          {copied ? "Copied" : "Copy"}
        </button>
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
      {error !== null && <div className="settings-error">{error}</div>}
    </div>
  );
};
