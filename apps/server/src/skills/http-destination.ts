import { err, ok, type Result } from "neverthrow";

/**
 * Where `ctx.http` may send a request: the URL checks the handler makes at
 * run time and the register-time Effects gate makes on a literal URL, one
 * implementation for both (design/skills.md → Register-time gates).
 */

/** Why a URL is not one `ctx.http` sends. */
export type HttpUrlRefusal = { kind: "unparseable" } | { kind: "not_http"; protocol: string };

/**
 * `url` parsed by WHATWG `URL.parse`, refused unless it is `http:` or
 * `https:`: a schema check that accepts any parseable URL would also admit
 * `file:` and `data:`, turning a network call into a host-filesystem read.
 */
export function parseHttpUrl(url: string): Result<URL, HttpUrlRefusal> {
  const parsed = URL.parse(url);
  if (parsed === null) return err({ kind: "unparseable" });
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err({ kind: "not_http", protocol: parsed.protocol });
  }
  return ok(parsed);
}

/**
 * Whether a hostname is covered by a manifest's `network.allow` list,
 * compared without case. An entry matches exactly, or — written
 * `*.example.com` — matches any host under that zone at any depth, so
 * `a.b.example.com` is admitted alongside `api.example.com`. The apex is not
 * implied: a skill wanting `example.com` itself lists it. An empty list
 * matches nothing, which is what makes "no `network:` block" mean "no
 * network" rather than "no restriction".
 *
 * Depth is deliberate rather than incidental — a CDN or bucket host is
 * routinely several labels deep, and a single-label rule would push authors
 * toward listing a bare apex, which is broader. It does mean a wildcard over a
 * zone with third-party sub-labels admits those too; that property belongs to
 * the zone, not the depth, and is a reason to name hosts exactly where the
 * zone is shared.
 */
export function hostAllowed(hostname: string, allow: ReadonlyArray<string>): boolean {
  const host = hostname.toLowerCase();
  return allow.some((listed) => {
    const entry = listed.toLowerCase();
    return entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry;
  });
}
