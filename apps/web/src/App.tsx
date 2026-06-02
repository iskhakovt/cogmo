import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "./orpc.js";

/**
 * Phase 1b proof: a token login that exchanges for a session cookie, then one
 * screen that reads `models.list` over oRPC behind the cookie. No Ledger theme,
 * no app shell — those land with the Phase 3 screens. The single read proves
 * the full loop: gate -> session -> Transport namespace.
 */
type View =
  | { kind: "loading" }
  | { kind: "login"; error?: string }
  | { kind: "ready"; models: readonly string[] };

export function App() {
  const [view, setView] = useState<View>({ kind: "loading" });

  // Probe the gated read. Success means we hold a valid session; any failure
  // behind the gate is "not authenticated", so the login screen is the next step.
  const probe = useCallback(async () => {
    try {
      const models = await api.models.list();
      setView({ kind: "ready", models });
    } catch {
      setView({ kind: "login" });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  async function login(token: string): Promise<void> {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    });
    if (res.ok) {
      await probe();
      return;
    }
    setView({
      kind: "login",
      error: res.status === 401 ? "Invalid token." : `Login failed (${res.status}).`,
    });
  }

  async function logout(): Promise<void> {
    await fetch("/api/session", { method: "DELETE", credentials: "include" });
    setView({ kind: "login" });
  }

  if (view.kind === "loading") {
    return <main className="page">Loading…</main>;
  }
  if (view.kind === "login") {
    return <LoginForm error={view.error} onSubmit={login} />;
  }
  return <Models models={view.models} onLogout={logout} />;
}

function LoginForm({
  error,
  onSubmit,
}: {
  error?: string | undefined;
  onSubmit: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit(token);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Cogmo</h1>
        <label htmlFor="token">Login token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button type="submit" disabled={busy || token.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error ? <p className="error">{error}</p> : null}
        <p className="hint">
          Run <code>cogmo web-token</code> to print the token.
        </p>
      </form>
    </main>
  );
}

function Models({
  models,
  onLogout,
}: {
  models: readonly string[];
  onLogout: () => Promise<void>;
}) {
  return (
    <main className="page">
      <div className="card">
        <header className="row">
          <h1>Models</h1>
          <button type="button" onClick={() => void onLogout()}>
            Log out
          </button>
        </header>
        {models.length === 0 ? (
          <p className="hint">No models configured.</p>
        ) : (
          <ul>
            {models.map((model) => (
              <li key={model}>{model}</li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
