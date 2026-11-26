/**
 * The policy for `POST /containers/create` (design/sandbox.md → Proxy
 * Design → Create policy). It builds a new body rather than patching the
 * one it received: the allowlisted fields as sent, the Cogmo labels, the
 * scope's runtime and cgroup parent, the task's resource limits, the
 * inspected image id and the published ports bound to the `bridge`
 * gateway.
 *
 * Every check on the body runs before any daemon lookup. The lookups go
 * through `DaemonLookups`, which the HTTP edge implements.
 */

import { err, ok, type Result, ResultAsync } from "neverthrow";
import * as R from "remeda";
import { type CreateBody, CreateBodySchema } from "./body-schemas.js";
import { bindToGateway, checkCreateFields, publishesPorts, taskLabels } from "./create-fields.js";
import { parseBody } from "./key-rules.js";
import { isHostPlatform } from "./platform.js";
import { denied, type ProxyRejection } from "./rejection.js";
import { limitResources, type ResourceFields } from "./resources.js";
import { checkSysboxEnv } from "./sysbox-env.js";
import type { DaemonLookups, ImageFacts, TaskScope } from "./types.js";

/**
 * The only create query keys the daemon reads. docker-modem also copies
 * every body option into the query (`Image=…&HostConfig=…`), and those are
 * dropped.
 */
const FORWARDED_QUERY_KEYS = ["name", "platform"] as const;

/** `HostConfig` fields the policy writes itself. */
const REPLACED_HOST_FIELDS = [
  "Memory",
  "MemorySwap",
  "PidsLimit",
  "NanoCpus",
  "CpuQuota",
  "CpuPeriod",
  "Runtime",
  "CgroupParent",
  "PortBindings",
] as const;

interface CreateForward {
  /** The re-serialised query, empty when no key is forwarded. */
  query: string;
  body: Buffer;
}

export function applyContainerCreatePolicy(
  request: { body: Buffer; query: URLSearchParams },
  scope: TaskScope,
  lookups: DaemonLookups,
): ResultAsync<CreateForward, ProxyRejection> {
  const query = forwardedQuery(request.query);
  return parseBody(request.body, CreateBodySchema)
    .andThen((body) =>
      checkCreateFields(body, scope)
        .andThen(() => limitResources(body.HostConfig ?? {}, scope.resourceLimits))
        .map((resources) => ({ body, resources })),
    )
    .asyncAndThen(({ body, resources }) =>
      new ResultAsync(checkPlatform(query.get("platform"), lookups))
        .andThen(() => new ResultAsync(lookups.inspectImage(body.Image)))
        .andThen((image) => checkSysboxEnv(image.env, "the image's Config.Env").map(() => image))
        .andThen((image) =>
          new ResultAsync(gatewayFor(body, lookups)).map((gateway) =>
            rebuild(body, { image, resources, gateway, scope }),
          ),
        ),
    )
    .map((rebuilt) => ({
      query: query.toString(),
      body: Buffer.from(JSON.stringify(rebuilt), "utf8"),
    }));
}

function forwardedQuery(query: URLSearchParams): URLSearchParams {
  return new URLSearchParams(
    FORWARDED_QUERY_KEYS.flatMap((key) => {
      const value = query.get(key);
      return value === null || value === "" ? [] : [[key, value]];
    }),
  );
}

async function checkPlatform(
  platform: string | null,
  lookups: DaemonLookups,
): Promise<Result<void, ProxyRejection>> {
  if (platform === null) return ok(undefined);
  const host = await lookups.hostPlatform();
  return host.andThen((self) =>
    isHostPlatform(platform, self)
      ? ok(undefined)
      : err(
          denied(
            `platform ${JSON.stringify(platform)} other than the daemon's ${self.os}/${self.arch}`,
          ),
        ),
  );
}

/**
 * Read on every create that publishes a port, not cached: a daemon restart
 * with another `bip` moves the gateway while this process runs.
 */
async function gatewayFor(
  body: CreateBody,
  lookups: DaemonLookups,
): Promise<Result<string | null, ProxyRejection>> {
  return publishesPorts(body.HostConfig?.PortBindings) ? lookups.bridgeGateway() : ok(null);
}

function rebuild(
  body: CreateBody,
  parts: { image: ImageFacts; resources: ResourceFields; gateway: string | null; scope: TaskScope },
): Record<string, unknown> {
  const { image, resources, gateway, scope } = parts;
  const config = R.omit(body, ["name", "platform", "Image", "Labels", "HostConfig"]);
  const host = body.HostConfig ?? {};
  const bindings = host.PortBindings;
  return {
    ...config,
    Image: image.id,
    Labels: taskLabels(body.Labels, scope),
    HostConfig: {
      ...R.omit(host, REPLACED_HOST_FIELDS),
      ...(bindings !== undefined && {
        PortBindings:
          bindings === null || gateway === null ? bindings : bindToGateway(bindings, gateway),
      }),
      Runtime: scope.runtime,
      CgroupParent: scope.cgroupParent,
      ...resources,
    },
  };
}
