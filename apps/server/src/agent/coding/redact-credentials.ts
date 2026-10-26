/** `scheme://user:secret@`; whitespace excluded so a match can't run across words. */
const URL_CREDENTIALS = /\b(https?):\/\/[^\s/@:]+:[^\s/@]+@/gi;

/** GitHub's classic, OAuth, user-to-server, server-to-server, refresh and fine-grained token prefixes. */
const GITHUB_TOKEN = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g;

/**
 * Masks credentials in text bound for a failure reason or an event payload.
 * Git masks the URLs it formats itself, but not text it relays (remote
 * messages, hook output), and other tools' error text makes no such promise.
 */
export function redactCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, "$1://***:***@").replace(GITHUB_TOKEN, "<REDACTED>");
}
