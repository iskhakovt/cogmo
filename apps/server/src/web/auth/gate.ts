import type { IncomingMessage } from "node:http";
import { parseCookies } from "./cookies.js";

/** The authenticated owner for a request — `platformUserHandle` feeds the Transport ACL. */
export interface WebIdentity {
  userId: string;
  platformUserHandle: string;
}

/**
 * One way to prove a request is the owner. The gate runs strategies in order
 * and the first to resolve wins (fail-closed: none resolving -> 401). Today the
 * cookie strategy is the only one; a trusted-identity-header strategy
 * (Cloudflare Access JWT / proxy secret) prepends to the list later.
 */
export interface AuthStrategy {
  resolve(req: IncomingMessage): Promise<WebIdentity | null>;
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * CSRF defense for same-origin cookie auth, no token (OWASP-accepted for JSON
 * APIs). Returns true when a state-changing request must be rejected (403):
 * its origin can't be proven same-site, or a body-bearing method isn't exactly
 * `application/json`. Safe methods (GET/HEAD) always pass.
 */
export function csrfReject(req: IncomingMessage): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (!STATE_CHANGING.has(method)) return false;

  // Origin gate: trust Sec-Fetch-Site same-origin/none, else an exact Origin-host match.
  const secFetchSite = headerValue(req, "sec-fetch-site");
  const sameSite = secFetchSite === "same-origin" || secFetchSite === "none";
  let originOk = false;
  if (!sameSite) {
    const origin = headerValue(req, "origin");
    const host = headerValue(req, "host");
    if (origin && host) {
      try {
        // Compare hostnames only — a TLS-terminating proxy commonly leaves the
        // Origin port implicit (:443) while the Host header keeps the internal
        // port, and a port mismatch isn't an attacker vector for CSRF. Parsing
        // the Host via URL handles IPv6 brackets that a `split(":")` would break.
        originOk = new URL(origin).hostname === new URL(`http://${host}`).hostname;
      } catch {
        originOk = false;
      }
    }
  }
  if (!sameSite && !originOk) return true;

  // Content-type gate for body-bearing methods: an HTML form can't send
  // application/json, so requiring it blocks classic form CSRF. DELETE carries
  // no body here and can't be form-issued anyway, so it's origin-gated only.
  if (method !== "DELETE") {
    const media = headerValue(req, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (media !== "application/json") return true;
  }
  return false;
}

/** Run strategies in order; first to resolve an identity wins. Null = unauthenticated. */
export async function authenticate(
  req: IncomingMessage,
  strategies: readonly AuthStrategy[],
): Promise<WebIdentity | null> {
  for (const strategy of strategies) {
    const identity = await strategy.resolve(req);
    if (identity) return identity;
  }
  return null;
}

/**
 * The cookie session strategy: read the session cookie, resolve it to a session
 * row, and stamp the owner handle. `resolveSession` is the bound use-case
 * (hash -> lookup -> touch); `ownerHandle` is the sentinel the wildcard web
 * channel resolves to the single owner.
 */
export function cookieStrategy(deps: {
  cookieName: string;
  ownerHandle: string;
  resolveSession: (rawToken: string) => Promise<{ userId: string } | null>;
}): AuthStrategy {
  return {
    async resolve(req) {
      const raw = parseCookies(headerValue(req, "cookie"))[deps.cookieName];
      if (!raw) return null;
      const session = await deps.resolveSession(raw);
      if (!session) return null;
      return { userId: session.userId, platformUserHandle: deps.ownerHandle };
    },
  };
}
