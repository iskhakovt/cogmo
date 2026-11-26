/**
 * `DaemonLookups` over the host Docker socket: the image inspect, the
 * daemon's platform and the address published ports bind to, which the
 * create policy needs. Every
 * failure is a value. A lookup is bound to the task's abort signal, so a
 * teardown ends it with the task's other daemon connections.
 */

import * as http from "node:http";
import { isIPv4 } from "node:net";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { describeError } from "../../util/describe-error.js";
import { malformed, notFound, unavailable } from "./rejection.js";
import type { DaemonLookups, HostPlatform, ImageFacts, LookupFailure } from "./types.js";

/** An image's config, labels included, is the task's own data: bound it. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

const ImageInspectSchema = z.object({
  Id: z.string().min(1),
  Config: z
    .object({ Env: z.array(z.string()).nullable().optional() })
    .nullable()
    .optional(),
});

/**
 * Where a rootless daemon publishes a port. RootlessKit listens in the
 * host's network namespace, where the `bridge` gateway is not an address,
 * so a start fails with `cannot assign requested address`; loopback keeps
 * the port off the host's other interfaces.
 */
const ROOTLESS_PUBLISH_ADDRESS = "127.0.0.1";

const VersionSchema = z.object({ Os: z.string().min(1), Arch: z.string().min(1) });

const InfoSchema = z.object({ SecurityOptions: z.array(z.string()).nullable().optional() });

const DaemonErrorSchema = z.object({ message: z.string() });

const NetworkInspectSchema = z.object({
  IPAM: z.object({
    Config: z
      .array(z.object({ Gateway: z.string().optional() }))
      .nullable()
      .optional(),
  }),
});

interface DaemonReply {
  status: number;
  /** `null` when the body is not JSON. */
  body: unknown;
  /** Why the body is not JSON, for the lookup's `unavailable` message. */
  unparsed: string | null;
}

export function daemonLookups(args: {
  socketPath: string;
  signal: AbortSignal;
  hostPlatform: (signal: AbortSignal) => Promise<Result<HostPlatform, LookupFailure>>;
  rootless: (signal: AbortSignal) => Promise<Result<boolean, LookupFailure>>;
}): DaemonLookups {
  const { socketPath, signal } = args;
  return {
    inspectImage: (ref) => inspectImage(socketPath, ref, signal),
    hostPlatform: () => args.hostPlatform(signal),
    publishAddress: async () => {
      const rootless = await args.rootless(signal);
      if (rootless.isErr()) return err(rootless.error);
      return rootless.value ? ok(ROOTLESS_PUBLISH_ADDRESS) : bridgeGateway(socketPath, signal);
    },
  };
}

/**
 * `load`, memoized once it succeeds. A failure is not kept, so the next
 * call tries again.
 */
export function cachedOnSuccess<T>(
  load: (signal: AbortSignal) => Promise<Result<T, LookupFailure>>,
): (signal: AbortSignal) => Promise<Result<T, LookupFailure>> {
  let cached: T | undefined;
  return async (signal) => {
    if (cached !== undefined) return ok(cached);
    const loaded = await load(signal);
    if (loaded.isOk()) cached = loaded.value;
    return loaded;
  };
}

export async function fetchHostPlatform(
  socketPath: string,
  signal: AbortSignal,
): Promise<Result<HostPlatform, LookupFailure>> {
  const reply = await getJson(socketPath, "/version", signal);
  return reply.andThen((answer) => {
    const { status, body } = answer;
    const parsed = VersionSchema.safeParse(body);
    return status === 200 && parsed.success
      ? ok({ os: parsed.data.Os, arch: parsed.data.Arch })
      : err(unavailable(`GET /version answered ${answered(answer)}`));
  });
}

/** Whether the daemon runs rootless, from `name=rootless` among `GET /info`'s `SecurityOptions`. */
export async function fetchRootless(
  socketPath: string,
  signal: AbortSignal,
): Promise<Result<boolean, LookupFailure>> {
  const reply = await getJson(socketPath, "/info", signal);
  return reply.andThen((answer) => {
    const { status, body } = answer;
    const parsed = InfoSchema.safeParse(body);
    return status === 200 && parsed.success
      ? ok((parsed.data.SecurityOptions ?? []).includes("name=rootless"))
      : err(unavailable(`GET /info answered ${answered(answer)}`));
  });
}

/** `ref` has passed the create schema's reference check, so it is a safe path segment run. */
async function inspectImage(
  socketPath: string,
  ref: string,
  signal: AbortSignal,
): Promise<Result<ImageFacts, LookupFailure>> {
  const reply = await getJson(socketPath, `/images/${ref}/json`, signal);
  return reply.andThen((answer) => {
    const { status, body } = answer;
    if (status === 404) return err(notFound(`No such image: ${ref}`));
    if (status === 400) return err(malformed(`image ${ref}: ${daemonReason(body)}`));
    const parsed = ImageInspectSchema.safeParse(body);
    return status === 200 && parsed.success
      ? ok({ id: parsed.data.Id, env: parsed.data.Config?.Env ?? [] })
      : err(unavailable(`the image inspect for ${ref} answered ${answered(answer)}`));
  });
}

async function bridgeGateway(
  socketPath: string,
  signal: AbortSignal,
): Promise<Result<string, LookupFailure>> {
  const reply = await getJson(socketPath, "/networks/bridge", signal);
  return reply.andThen((answer) => {
    const { status, body } = answer;
    const parsed = NetworkInspectSchema.safeParse(body);
    const gateway = parsed.success
      ? (parsed.data.IPAM.Config ?? [])
          .map((c) => c.Gateway)
          .find((g) => g !== undefined && isIPv4(g))
      : undefined;
    return status === 200 && gateway !== undefined
      ? ok(gateway)
      : err(
          unavailable(`GET /networks/bridge answered ${answered(answer)} without an IPv4 gateway`),
        );
  });
}

function daemonReason(body: unknown): string {
  const parsed = DaemonErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.message : "the daemon refused it";
}

function getJson(
  socketPath: string,
  path: string,
  signal: AbortSignal,
): Promise<Result<DaemonReply, LookupFailure>> {
  return new Promise((resolve) => {
    const fail = (cause: unknown) =>
      resolve(err(unavailable(`GET ${path}: ${describeError(cause)}`)));
    const req = http.request({ socketPath, method: "GET", path, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) {
          res.destroy();
          fail(`the reply exceeds ${MAX_REPLY_BYTES} bytes`);
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => resolve(ok(parseReply(res.statusCode ?? 0, Buffer.concat(chunks)))));
    });
    req.on("error", fail);
    req.end();
  });
}

/**
 * The status with the body parsed, or `null` for a body that is not JSON: a
 * 404 still means the image is missing, and each lookup's schema refuses a
 * `null` it needed.
 */
function parseReply(status: number, raw: Buffer): DaemonReply {
  try {
    return { status, body: JSON.parse(raw.toString("utf8")), unparsed: null };
  } catch (cause) {
    return { status, body: null, unparsed: describeError(cause) };
  }
}

/** `200`, or `200 with a body that is not JSON (…)`, for an `unavailable` message. */
function answered(reply: DaemonReply): string {
  return reply.unparsed === null
    ? String(reply.status)
    : `${reply.status} with a body that is not JSON (${reply.unparsed})`;
}
