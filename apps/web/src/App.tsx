import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ChatView } from "./chat/ChatView.js";
import { api } from "./orpc.js";

/**
 * A token login that exchanges for a session cookie, then the streaming chat
 * screen behind the cookie. No Ledger theme / app shell yet — those land with
 * the Phase 3 screens.
 */
type View = { kind: "loading" } | { kind: "login"; error?: string } | { kind: "ready" };

export function App() {
  const [view, setView] = useState<View>({ kind: "loading" });

  // Probe a gated read to check the session. Success means we hold a valid
  // session; any failure behind the gate is "not authenticated" -> login.
  const probe = useCallback(async () => {
    try {
      await api.models.list();
      setView({ kind: "ready" });
    } catch {
      setView({ kind: "login" });
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  async function login(token: string): Promise<void> {
    try {
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
    } catch {
      // A throw here is a transport failure (server down, connection refused) —
      // `probe` swallows its own errors, so this only fires on the fetch itself.
      setView({ kind: "login", error: "Connection failed — is the server running?" });
    }
  }

  async function logout(): Promise<void> {
    // Best-effort: the session cookie is httpOnly, so the client can't clear it
    // and a transport failure can't be surfaced usefully. Drop to the login view
    // regardless; a still-valid server session simply resurfaces on next load.
    try {
      await fetch("/api/session", { method: "DELETE", credentials: "include" });
    } catch {
      // ignore — fall through to the login view
    }
    setView({ kind: "login" });
  }

  if (view.kind === "loading") {
    return <main className="page">Loading…</main>;
  }
  if (view.kind === "login") {
    return <LoginForm error={view.error} onSubmit={login} />;
  }
  return <ChatView onLogout={logout} />;
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
    // The login token is base64url (no internal whitespace); trim so a pasted
    // trailing newline doesn't read back as an invalid token.
    const trimmed = token.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
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
          disabled={busy}
          onChange={(e) => setToken(e.target.value)}
        />
        <button type="submit" disabled={busy || token.trim().length === 0}>
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
