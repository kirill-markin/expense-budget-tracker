"use client";

import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error: string };
        setError(data.error);
        return;
      }

      window.location.href = "/";
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-container">
      <section className="panel">
        <h1 className="title">Login</h1>
        <form onSubmit={handleSubmit}>
          <label className="login-field">
            <span className="login-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
              className="login-input"
            />
          </label>
          {error !== "" && <p className="login-error">{error}</p>}
          <button type="submit" disabled={loading} className="login-btn">
            {loading ? "Logging in..." : "Log in"}
          </button>
        </form>
      </section>
    </main>
  );
}
