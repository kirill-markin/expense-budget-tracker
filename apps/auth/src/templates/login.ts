/**
 * Login page HTML template. Vanilla HTML + CSS + JS — no React, no bundler.
 *
 * CSS uses design tokens from globals.css (:root vars, monospace font, no border-radius).
 * JS implements the same two-step OTP flow as the old LoginForm.tsx.
 * On successful verification, auth service sets session cookies (Domain=COOKIE_DOMAIN)
 * and client JS redirects to redirect_uri.
 * RTL: dir="rtl" when locale is fa, ar, or he; CSS logical properties throughout.
 */
import { t } from "../i18n/translations.js";

const RTL_LOCALES = new Set(["fa", "ar", "he"]);

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const LOCALE_LABELS: Readonly<Record<string, string>> = {
  en: "English",
  ru: "Русский",
  es: "Español",
  uk: "Українська",
  fa: "فارسی",
  zh: "中文",
  ar: "العربية",
  he: "עברית",
};

const SUPPORTED_LOCALES = ["en", "es", "zh", "ru", "uk", "fa", "ar", "he"] as const;

export const renderLoginPage = (locale: string, redirectUri: string): string => {
  const dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";
  const lang = locale;

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(t(locale, "title"))}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='96' fill='%23232323'/%3E%3Cpath d='M256 80v352' stroke='%23fff' stroke-width='40' stroke-linecap='round'/%3E%3Cpath d='M336 176c0-44-36-72-80-72s-80 28-80 72c0 48 40 64 80 80s80 32 80 80c0 44-36 72-80 72s-80-28-80-72' stroke='%23fff' stroke-width='40' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E">
  <style>
    :root {
      --bg: #ffffff;
      --panel: #ffffff;
      --panel-border: #232323;
      --text: #000000;
      --muted: #898989;
      --accent: #232323;
    }

    * { box-sizing: border-box; }
    *:focus { outline: none; }

    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .login-page {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
      width: 100%;
    }

    .login-card {
      width: 100%;
      max-width: 360px;
      border: 1px solid var(--panel-border);
      padding: 32px 28px;
      background: var(--panel);
    }

    .login-title {
      margin: 0 0 24px;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0.2px;
    }

    .login-label {
      display: block;
      margin-bottom: 6px;
      font-size: 13px;
      color: var(--muted);
    }

    .login-input {
      display: block;
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 16px;
      border: 1px solid var(--panel-border);
      background: var(--bg);
      color: var(--text);
      font-family: inherit;
      font-size: 14px;
    }

    .login-input:focus {
      border-color: var(--text);
    }

    .login-btn {
      display: block;
      width: 100%;
      padding: 10px;
      border: 1px solid var(--panel-border);
      background: var(--accent);
      color: var(--bg);
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .login-btn:hover {
      opacity: 0.85;
    }

    .login-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .login-error {
      color: #c0392b;
      font-size: 13px;
      margin-bottom: 12px;
    }

    .login-hint {
      color: var(--muted);
      font-size: 13px;
      margin: 0 0 16px;
    }

    .login-lang {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 16px;
    }

    .login-lang select {
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--panel-border);
      font-family: inherit;
      font-size: 12px;
      padding: 4px 6px;
      cursor: pointer;
    }

    .hidden { display: none; }

    @media (max-width: 768px) {
      .login-page { padding: 0; }
      .login-card {
        border: none;
        max-width: none;
        padding: 32px 16px;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
    }
  </style>
</head>
<body>
  <div class="login-page">
    <div class="login-card">
      <div class="login-lang">
        <select id="lang-select">
          ${SUPPORTED_LOCALES.map((l) => `<option value="${l}"${l === locale ? " selected" : ""}>${escapeHtml(LOCALE_LABELS[l])}</option>`).join("\n          ")}
        </select>
      </div>
      <h1 class="login-title">${escapeHtml(t(locale, "title"))}</h1>

      <div id="step-email">
        <label class="login-label" for="login-email">${escapeHtml(t(locale, "email"))}</label>
        <input id="login-email" class="login-input" type="email" autocomplete="email" autofocus>
        <div id="email-error" class="login-error hidden"></div>
        <button id="send-btn" class="login-btn" type="button">${escapeHtml(t(locale, "sendCode"))}</button>
      </div>

      <div id="step-otp" class="hidden">
        <p class="login-hint">${escapeHtml(t(locale, "checkEmail"))}</p>
        <label class="login-label" for="login-otp">${escapeHtml(t(locale, "otp"))}</label>
        <input id="login-otp" class="login-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8">
        <div id="otp-error" class="login-error hidden"></div>
        <button id="verify-btn" class="login-btn" type="button">${escapeHtml(t(locale, "verify"))}</button>
      </div>
    </div>
  </div>

  <script>
    (function() {
      var redirectUri = ${JSON.stringify(redirectUri)};

      document.getElementById("lang-select").addEventListener("change", function() {
        window.location.href = "/login?redirect_uri=" + encodeURIComponent(redirectUri) + "&lang=" + this.value;
      });

      var csrfToken = "";
      var sendingLabel = ${JSON.stringify(t(locale, "sending"))};
      var sendCodeLabel = ${JSON.stringify(t(locale, "sendCode"))};
      var verifyingLabel = ${JSON.stringify(t(locale, "verifying"))};
      var verifyLabel = ${JSON.stringify(t(locale, "verify"))};

      var emailInput = document.getElementById("login-email");
      var otpInput = document.getElementById("login-otp");
      var sendBtn = document.getElementById("send-btn");
      var verifyBtn = document.getElementById("verify-btn");
      var stepEmail = document.getElementById("step-email");
      var stepOtp = document.getElementById("step-otp");
      var emailError = document.getElementById("email-error");
      var otpError = document.getElementById("otp-error");

      function showError(el, msg) {
        el.textContent = msg;
        el.classList.remove("hidden");
      }

      function hideError(el) {
        el.classList.add("hidden");
        el.textContent = "";
      }

      otpInput.addEventListener("input", function() {
        otpInput.value = otpInput.value.replace(/\\D/g, "").slice(0, 8);
      });

      emailInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") sendBtn.click();
      });

      otpInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") verifyBtn.click();
      });

      sendBtn.addEventListener("click", function() {
        var email = emailInput.value.trim();
        if (!email) return;

        hideError(emailError);
        sendBtn.disabled = true;
        sendBtn.textContent = sendingLabel;

        fetch("/api/send-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email: email }),
        })
          .then(function(res) {
            return res.json().then(function(data) {
              if (!res.ok) {
                showError(emailError, data.error || "Error: " + res.status);
                return;
              }
              csrfToken = data.csrfToken || "";
              stepEmail.classList.add("hidden");
              stepOtp.classList.remove("hidden");
              otpInput.focus();
            });
          })
          .catch(function(err) {
            showError(emailError, err.message || String(err));
          })
          .finally(function() {
            sendBtn.disabled = false;
            sendBtn.textContent = sendCodeLabel;
          });
      });

      verifyBtn.addEventListener("click", function() {
        var code = otpInput.value.trim();
        if (code.length !== 8) return;

        hideError(otpError);
        verifyBtn.disabled = true;
        verifyBtn.textContent = verifyingLabel;

        fetch("/api/verify-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            code: code,
            csrfToken: csrfToken,
          }),
        })
          .then(function(res) {
            return res.json().then(function(data) {
              if (!res.ok) {
                showError(otpError, data.error || "Error: " + res.status);
                return;
              }
              // Cookies set by server response — redirect to app
              window.location.href = redirectUri;
            });
          })
          .catch(function(err) {
            showError(otpError, err.message || String(err));
          })
          .finally(function() {
            verifyBtn.disabled = false;
            verifyBtn.textContent = verifyLabel;
          });
      });
    })();
  </script>
</body>
</html>`;
};
