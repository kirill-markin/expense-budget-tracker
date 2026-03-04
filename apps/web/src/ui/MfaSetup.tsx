"use client";

import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type MfaStatus = Readonly<{ enabled: boolean; available: boolean }>;
type SetupResponse = Readonly<{ secretCode: string; totpUri: string }>;

type Props = Readonly<{
  authEnabled: boolean;
}>;

export const MfaSetup = (props: Props): ReactElement | null => {
  const { authEnabled } = props;
  const { t } = useTranslation();
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
      setError(t("mfa.codeError"));
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
      setSuccess(t("mfa.enabled"));
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
      setSuccess(t("mfa.disabled"));
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
          <div className="settings-label">{t("mfa.active")}</div>
          <div className="settings-control">
            <button
              className="settings-save settings-save--danger"
              type="button"
              onClick={handleDisable}
              disabled={loading}
            >
              {loading ? t("mfa.disabling") : t("mfa.disable")}
            </button>
          </div>
        </div>
      )}

      {!status.enabled && setup === null && (
        <div className="settings-row">
          <div className="settings-label">
            {t("mfa.setupHelp")}
          </div>
          <div className="settings-control">
            <button
              className="settings-save"
              type="button"
              onClick={handleSetup}
              disabled={loading}
            >
              {loading ? t("mfa.setupLoading") : t("mfa.setup")}
            </button>
          </div>
        </div>
      )}

      {setup !== null && (
        <div className="settings-row">
          <div className="settings-label">
            {t("mfa.addKeyHelp")}
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
              placeholder={t("mfa.codePlaceholder")}
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
              {loading ? t("mfa.verifying") : t("mfa.verify")}
            </button>
          </div>
        </div>
      )}

      {error !== "" && <div className="settings-error">{error}</div>}
      {success !== "" && <div className="settings-saved">{success}</div>}
    </div>
  );
};
