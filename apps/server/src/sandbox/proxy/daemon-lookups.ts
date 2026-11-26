/**
 * `DaemonLookups` over the host Docker socket: the image inspect, the
 * daemon's platform and the `bridge` gateway the create policy needs. Every
 * failure is a value. A lookup is bound to the task's abort signal, so a
 * teardown ends it with the task's other daemon connections.
 */

import * as http from "node:http";
import { isIPv4 } from "node:net";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { describeError } from "../../util/describe-error.js";
import { notFound, unavailable } from "./rejection.js";
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

const VersionSchema = z.object({ Os: z.string().min(1), Arch: z.string().min(1) });

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
  body: unknown;
}

export function daemonLookups(args: {
  socketPath: string;
  signal: AbortSignal;
  hostPlatform: (signal: AbortSignal) => Promise<Result<HostPlatform, LookupFailure>>;
}): DaemonLookups {
  const { socketPath, signal } = args;
  return {
    inspectImage: (ref) => inspectImage(socketPath, ref, signal),
    hostPlatform: () => args.hostPlatform(signal),
    bridgeGateway: () => bridgeGateway(socketPath, signal),
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
  return reply.andThen(({ status, body }) => {
    const parsed = VersionSchema.safeParse(body);
    return status === 200 && parsed.success
      ? ok({ os: parsed.data.Os, arch: parsed.data.Arch })
      : err(unavailable(`GET /version answered ${status}`));
  });
}

/** `ref` has passed the create schema's reference check, so it is a safe path segment run. */
async function inspectImage(
  socketPath: string,
  ref: string,
  signal: AbortSignal,
): Promise<Result<ImageFacts, LookupFailure>> {
  const reply = await getJson(socketPath, `/images/${ref}/json`, signal);
  return reply.andThen(({ status, body }) => {
    if (status === 404) return err(notFound(`No such image: ${ref}`));
    const parsed = ImageInspectSchema.safeParse(body);
    return status === 200 && parsed.success
      ? ok({ id: parsed.data.Id, env: parsed.data.Config?.Env ?? [] })
      : err(unavailable(`the image inspect for ${ref} answered ${status}`));
  });
}

async function bridgeGateway(
  socketPath: string,
  signal: AbortSignal,
): Promise<Result<string, LookupFailure>> {
  const reply = await getJson(socketPath, "/networks/bridge", signal);
  return reply.andThen(({ status, body }) => {
    const parsed = NetworkInspectSchema.safeParse(body);
    const gateway = parsed.success
      ? (parsed.data.IPAM.Config ?? [])
          .map((c) => c.Gateway)
          .find((g) => g !== undefined && isIPv4(g))
      : undefined;
    return status === 200 && gateway !== undefined
      ? ok(gateway)
      : err(unavailable(`GET /networks/bridge answered ${status} without an IPv4 gateway`));
  });
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
      res.on("end", () => resolve(parseReply(res.statusCode ?? 0, Buffer.concat(chunks))));
    });
    req.on("error", fail);
    req.end();
  });
}

function parseReply(status: number, raw: Buffer): Result<DaemonReply, LookupFailure> {
  try {
    return ok({ status, body: JSON.parse(raw.toString("utf8")) });
  } catch (cause) {
    return err(
      unavailable(
        `the daemon answered ${status} with a body that is not JSON: ${describeError(cause)}`,
      ),
    );
  }
}
