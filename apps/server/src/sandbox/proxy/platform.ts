/**
 * Whether a create's `platform` query names the daemon's own platform, read
 * as containerd's `platforms.Parse` and then `platforms.Normalize` read it
 * (github.com/containerd/platforms, `platforms.go` and `database.go`). A
 * one-part specifier is an OS or an architecture, the other part taken from
 * the daemon. An OS version or feature list (`linux(10.0)`), a wildcard, an
 * unknown single part or more than three parts never match, so a create can
 * only ask for the image the inspect resolved.
 */

import type { HostPlatform } from "./types.js";

interface Platform {
  os: string;
  arch: string;
  variant: string;
}

/** go/build's known OS list, as containerd's `isKnownOS`. */
const KNOWN_OS: ReadonlySet<string> = new Set([
  "aix",
  "android",
  "darwin",
  "dragonfly",
  "freebsd",
  "hurd",
  "illumos",
  "ios",
  "js",
  "linux",
  "nacl",
  "netbsd",
  "openbsd",
  "plan9",
  "solaris",
  "windows",
  "zos",
]);

/** go/build's known architecture list, as containerd's `isKnownArch`. */
const KNOWN_ARCH: ReadonlySet<string> = new Set([
  "386",
  "amd64",
  "amd64p32",
  "arm",
  "armbe",
  "arm64",
  "arm64be",
  "ppc64",
  "ppc64le",
  "loong64",
  "mips",
  "mipsle",
  "mips64",
  "mips64le",
  "mips64p32",
  "mips64p32le",
  "ppc",
  "riscv",
  "riscv64",
  "s390",
  "s390x",
  "sparc",
  "sparc64",
  "wasm",
]);

const OS_PART = /^[A-Za-z0-9_-]+$/;
const OTHER_PART = /^[A-Za-z0-9_.-]+$/;

export function isHostPlatform(specifier: string, host: HostPlatform): boolean {
  const self = normalize({ os: host.os, arch: host.arch, variant: "" });
  const asked = parse(specifier, self);
  return (
    asked !== null &&
    asked.os === self.os &&
    asked.arch === self.arch &&
    asked.variant === self.variant
  );
}

function parse(specifier: string, self: Platform): Platform | null {
  const parts = specifier.split("/");
  const [first, arch, variant, ...rest] = parts;
  if (first === undefined || !OS_PART.test(first) || rest.length > 0) return null;
  if (!parts.slice(1).every((part) => OTHER_PART.test(part) && part !== "." && part !== "..")) {
    return null;
  }
  if (arch === undefined) return parseSingle(first, self);
  return normalize({ os: first, arch, variant: variant ?? "" });
}

function parseSingle(part: string, self: Platform): Platform | null {
  const os = normalizeOs(part);
  if (KNOWN_OS.has(os)) return { os, arch: self.arch, variant: self.variant };
  const asArch = normalize({ os: self.os, arch: part, variant: "" });
  return KNOWN_ARCH.has(asArch.arch) ? asArch : null;
}

function normalize(p: Platform): Platform {
  const [arch, variant] = normalizeArch(p.arch.toLowerCase(), p.variant.toLowerCase());
  return { os: normalizeOs(p.os), arch, variant };
}

function normalizeOs(os: string): string {
  const lower = os.toLowerCase();
  return lower === "macos" ? "darwin" : lower;
}

/** containerd's `normalizeArch`. */
function normalizeArch(arch: string, variant: string): [string, string] {
  if (arch === "i386") return ["386", ""];
  if (arch === "x86_64" || arch === "x86-64" || arch === "amd64") {
    return ["amd64", variant === "v1" ? "" : variant];
  }
  if (arch === "aarch64" || arch === "arm64") return ["arm64", arm64Variant(variant)];
  if (arch === "armhf") return ["arm", "v7"];
  if (arch === "armel") return ["arm", "v6"];
  if (arch === "arm") return ["arm", armVariant(variant)];
  return [arch, variant];
}

function arm64Variant(variant: string): string {
  if (variant === "8" || variant === "v8" || variant === "v8.0") return "";
  if (variant === "9" || variant === "9.0" || variant === "v9.0") return "v9";
  return variant;
}

function armVariant(variant: string): string {
  if (variant === "" || variant === "7") return "v7";
  if (variant === "5" || variant === "6" || variant === "8") return `v${variant}`;
  return variant;
}
