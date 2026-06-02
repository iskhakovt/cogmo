import { RouterProvider } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AppProvider } from "./app-context.js";
import { api } from "./orpc.js";
import { router } from "./router.js";

/**
 * Per-tab id — the channel session's address + SSE registry key. Not a credential
 * (the cookie is). `crypto.randomUUID` needs a secure context, so fall back for a
 * plain-HTTP LAN bind; uniqueness, not unpredictability, is what matters.
 */
function newTabId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type View = { kind: "loading" } | { kind: "login"; error?: string } | { kind: "ready" };

/** Auth boundary: probe the session, then mount the routed cockpit or the login screen. */
export function App() {
  const tab = useRef(newTabId()).current;
  const [view, setView] = useState<View>({ kind: "loading" });

  // Probe a gated read to check the session; any failure behind the gate -> login.
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
      setView({ kind: "login", error: "Connection failed — is the server running?" });
    }
  }

  const logout = useCallback(async () => {
    try {
      await fetch("/api/session", { method: "DELETE", credentials: "include" });
    } catch {
      // ignore — fall through to the login view regardless
    }
    setView({ kind: "login" });
  }, []);

  if (view.kind === "loading") {
    return <main className="grid h-dvh place-items-center text-sm text-muted">Loading…</main>;
  }
  if (view.kind === "login") {
    return <LoginForm error={view.error} onSubmit={login} />;
  }
  return (
    <AppProvider value={{ tab, logout }}>
      <RouterProvider router={router} />
    </AppProvider>
  );
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
    <main className="grid h-dvh place-items-center px-6">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-line bg-surface p-6"
      >
        <h1 className="font-mono text-base font-semibold tracking-wide text-ink">Cogmo</h1>
        <label htmlFor="token" className="text-xs text-muted">
          Login token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={token}
          disabled={busy}
          onChange={(e) => setToken(e.target.value)}
          className="rounded border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || token.trim().length === 0}
          className="rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error ? <p className="text-xs text-bad">{error}</p> : null}
        <p className="text-xs text-faint">
          Run <code className="font-mono text-muted">cogmo web-token</code> to print the token.
        </p>
      </form>
    </main>
  );
}
