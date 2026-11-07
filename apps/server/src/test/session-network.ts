import type { SandboxSession } from "../sandbox/index.js";

/**
 * A session's network as its own namespace sees it: its interfaces, and
 * whether it has a default route. Read from `/proc/net`, which is per network
 * namespace; under sysbox `/sys/class/net` lists the host's interfaces.
 */
export async function sessionNetwork(
  session: Pick<SandboxSession, "exec">,
): Promise<{ interfaces: string[]; defaultRoute: boolean }> {
  const [dev, route] = await Promise.all([
    session.exec(["cat", "/proc/net/dev"]),
    session.exec(["cat", "/proc/net/route"]),
  ]);
  if (dev.exitCode !== 0 || route.exitCode !== 0) {
    throw new Error(`reading /proc/net failed: ${dev.stderr}${route.stderr}`);
  }
  // Two header lines, then `<iface>: <counters>`.
  const interfaces = dev.stdout
    .split("\n")
    .slice(2)
    .flatMap((line) => {
      const name = line.split(":")[0]?.trim();
      return name ? [name] : [];
    });
  // One header line, then `<iface>\t<destination hex>\t…`; 00000000 is the default route.
  const defaultRoute = route.stdout
    .split("\n")
    .slice(1)
    .some((line) => line.trim().split(/\s+/)[1] === "00000000");
  return { interfaces, defaultRoute };
}
