Bumps the runtime base image from `node:24-slim` (Debian 12,
bookworm) to `node:24-trixie-slim` (Debian 13.5, trixie). Picks up
newer upstream package versions: `ncurses` 6.4 -> 6.5, `util-linux`
2.38 -> 2.41, `zlib` 1.2.13 -> 1.3.1, `tar` 1.34 -> 1.35, plus the
fresh `libgcrypt` / `libgnutls` from the `apt-get upgrade` step.

Trivy OS-package finding counts (HIGH+CRITICAL+MEDIUM) drop from
63 to 55 rows on the published image, with the standout being
CVE-2023-45853 (zlib CRITICAL, integer overflow in
`zipOpenNewFileInZip4_6`) — fixed upstream in zlib 1.3.0, never
backported to bookworm, gone in trixie. Remaining findings are
the same shape as before: `util-linux` TOCTOU + hostname-canon,
`ncurses` buffer overflow, `tar` hidden-file injection, `zlib`
CRC32 DoS — all `affected` with no fix in any current Debian.

The `node` user (UID 1000) and the `apt` package set we install
(`ca-certificates`, `git`, `openssh-client`) are unchanged
between bookworm and trixie, so the runtime contract is intact.
