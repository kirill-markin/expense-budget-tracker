"use client";

import { type ReactElement, useCallback, useEffect, useState } from "react";

type MfaStatus = Readonly<{ enabled: boolean; available: boolean }>;
type SetupResponse = Readonly<{ secretCode: string; totpUri: string }>;

type Props = Readonly<{
  authEnabled: boolean;
}>;

export const MfaSetup = (props: Props): ReactElement | null => {
  const { authEnabled } = props;
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");

  useEffect(() => {
    if (!authEnabled) return;
    fetch("/api/auth/mfa")
      .then((r) => r.json() as Promise<MfaStatus>)
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, available: false }));
  }, [authEnabled]);

  const handleSetup = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/auth/mfa/setup", { method: "POST" });
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      const data = await response.json() as SetupResponse;
      setSetup(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleVerify = useCallback(async (): Promise<void> => {
    if (!/^\d{6}$/.test(code)) {
      setError("Enter a 6-digit code");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      setStatus({ enabled: true, available: true });
      setSetup(null);
      setCode("");
      setSuccess("MFA enabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [code]);

  const handleDisable = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/auth/mfa", { method: "DELETE" });
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      setStatus({ enabled: false, available: true });
      setSuccess("MFA disabled");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  if (!authEnabled || status === null || !status.available) return null;

  return (
    <div className="settings-form">
      {status.enabled && setup === null && (
        <div className="settings-row">
          <div className="settings-label">TOTP authenticator is active</div>
          <div className="settings-control">
            <button
              className="settings-save settings-save--danger"
              type="button"
              onClick={handleDisable}
              disabled={loading}
            >
              {loading ? "Disabling..." : "Disable MFA"}
            </button>
          </div>
        </div>
      )}

      {!status.enabled && setup === null && (
        <div className="settings-row">
          <div className="settings-label">
            Protect your account with a TOTP authenticator app
          </div>
          <div className="settings-control">
            <button
              className="settings-save"
              type="button"
              onClick={handleSetup}
              disabled={loading}
            >
              {loading ? "Loading..." : "Setup MFA"}
            </button>
          </div>
        </div>
      )}

      {setup !== null && (
        <div className="settings-row">
          <div className="settings-label">
            Add this key to your authenticator app (Google Authenticator, 1Password, etc.)
          </div>
          <div className="settings-codeblock">
            <code>{setup.secretCode}</code>
          </div>
          <div className="settings-control">
            <input
              className="settings-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(""); }}
              disabled={loading}
            />
            <button
              className="settings-save"
              type="button"
              onClick={handleVerify}
              disabled={loading || code.length !== 6}
            >
              {loading ? "Verifying..." : "Verify"}
            </button>
          </div>
        </div>
      )}

      {error !== "" && <div className="settings-error">{error}</div>}
      {success !== "" && <div className="settings-saved">{success}</div>}
    </div>
  );
};
