/**
 * Session cookie names. The hardened `__Host-` prefix pins the cookie to the
 * exact host, forbids a `Domain`, and requires `Secure` + `Path=/` — but
 * browsers reject `__Host-`+`Secure` on plain `http://localhost`, so the dev
 * escape hatch (`WEB_INSECURE_COOKIES`) uses the unprefixed name.
 */
const COOKIE_SECURE = "__Host-session";
const COOKIE_INSECURE = "session";

/** Cookie name for the current security mode. */
export function sessionCookieName(secure: boolean): string {
  return secure ? COOKIE_SECURE : COOKIE_INSECURE;
}

/** Parse a `Cookie` request header into a name->value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    // A malformed percent-encoding (`%zz`) in any cookie on the host would
    // otherwise throw a URIError and 500 the whole request — fall back to raw.
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/** Build the `Set-Cookie` value that mints the session. */
export function buildSessionCookie(
  rawToken: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const attrs = [
    `${sessionCookieName(opts.secure)}=${rawToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Build the `Set-Cookie` value that clears the session (logout). */
export function buildClearCookie(opts: { secure: boolean }): string {
  const attrs = [
    `${sessionCookieName(opts.secure)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
