/**
 * `cogmo connector <command>` — register the out-of-process connectors cogmo
 * dispatches jobs to, and manage their bearer tokens. See design/connectors.md
 * → Wire contract → Auth.
 */

import { command, extendType, option, positional, subcommands } from "cmd-ts";
import { match } from "ts-pattern";
import {
  type AddConnectorError,
  addConnector,
  CONNECTOR_NAME_RE,
} from "../connector/add-connector.js";
import { AUTH_REFRESH_MS, STALE_CHECK_MS, STALE_MS } from "../connector/auth.js";
import { revokeConnector } from "../connector/revoke-connector.js";
import { rotateConnectorToken } from "../connector/rotate-connector-token.js";
import type { ConnectorKind, ConnectorStore } from "../connector/store/index.js";
import { CONNECTOR_KINDS } from "../connector/store/schema.js";
import type { Transactor } from "../db/index.js";
import { choice, identifier } from "./args.js";
import type { CliIo, LoadDeps } from "./run.js";

export interface ConnectorCliDeps {
  runInTx: Transactor;
  connectorStore: ConnectorStore;
}

/**
 * How soon a rotate or revoke reaches a running server: its auth cache's next
 * refresh, or, while the server can't read its database, the cache going stale.
 */
const REVOKE_WITHIN = `${AUTH_REFRESH_MS / 1_000} s (${(STALE_MS + STALE_CHECK_MS) / 1_000} s while the server can't read its database)`;

const TOKEN_ONCE = "The token above is shown only once: put it in the connector's config.";

/** A name `connector add` can register. */
const connectorName = extendType(identifier("name"), {
  async from(name) {
    if (!CONNECTOR_NAME_RE.test(name)) {
      throw new Error(describeAddError({ kind: "invalid_name" }, name));
    }
    return name;
  },
});

const existingName = positional({
  type: identifier("name"),
  displayName: "name",
  description: "An active connector.",
});

export function connectorCli(io: CliIo, loadDeps: LoadDeps<ConnectorCliDeps>) {
  return subcommands({
    name: "connector",
    description: "Manage the out-of-process connectors cogmo dispatches jobs to.",
    cmds: {
      add: command({
        name: "add",
        description: "Register a connector and print its token, once.",
        args: {
          name: positional({
            type: connectorName,
            displayName: "name",
            description: "Lowercase letters, digits, - and _, letter-led, at most 32 chars.",
          }),
          kind: option({
            long: "kind",
            type: choice(CONNECTOR_KINDS, "kind"),
            description: "The work it takes.",
          }),
        },
        examples: [
          {
            description: "A coding connector",
            command: "cogmo connector add laptop --kind coding",
          },
        ],
        handler: async (args) => add(args, await loadDeps(), io),
      }),
      rotate: command({
        name: "rotate",
        description: "Replace a connector's token and print the new one, once.",
        args: { name: existingName },
        handler: async (args) => rotate(args, await loadDeps(), io),
      }),
      revoke: command({
        name: "revoke",
        description: "Revoke a connector. Its jobs in flight are lost.",
        args: { name: existingName },
        handler: async (args) => revoke(args, await loadDeps(), io),
      }),
      list: command({
        name: "list",
        description: "Show every connector, active and revoked.",
        args: {},
        handler: async () => list(await loadDeps(), io),
      }),
    },
  });
}

async function add(
  args: { name: string; kind: ConnectorKind },
  deps: ConnectorCliDeps,
  io: CliIo,
): Promise<number> {
  const added = await addConnector(deps, args);
  if (added.isErr()) {
    io.err(describeAddError(added.error, args.name));
    return 1;
  }
  io.out(added.value.token);
  io.out(`Added ${args.kind} connector "${args.name}". ${TOKEN_ONCE}`);
  return 0;
}

function describeAddError(e: AddConnectorError, name: string): string {
  return match(e)
    .with(
      { kind: "invalid_name" },
      () =>
        `Invalid connector name "${name}": it must be lowercase ASCII letters/digits/hyphen/underscore, start with a letter, ≤32 chars.`,
    )
    .with({ kind: "name_taken" }, () => `An active connector named "${name}" already exists.`)
    .exhaustive();
}

async function rotate(args: { name: string }, deps: ConnectorCliDeps, io: CliIo): Promise<number> {
  const rotated = await rotateConnectorToken(deps, args);
  if (rotated.isErr()) {
    io.err(describeNotFound(rotated.error, args.name));
    return 1;
  }
  io.out(rotated.value.token);
  io.out(`Rotated the token of connector "${args.name}". ${TOKEN_ONCE}`);
  io.out(
    `The old token stops working within ${REVOKE_WITHIN}. Reconnect the connector with the new one within the lease (CONNECTOR_LEASE_SECONDS), or its jobs in flight are lost.`,
  );
  return 0;
}

async function revoke(args: { name: string }, deps: ConnectorCliDeps, io: CliIo): Promise<number> {
  const revoked = await revokeConnector(deps, { name: args.name, now: new Date() });
  if (revoked.isErr()) {
    io.err(describeNotFound(revoked.error, args.name));
    return 1;
  }
  io.out(
    `Revoked connector "${args.name}". Its stream closes within ${REVOKE_WITHIN}, and its jobs in flight are lost.`,
  );
  return 0;
}

function describeNotFound(e: { kind: "not_found" }, name: string): string {
  return match(e)
    .with({ kind: "not_found" }, () => `No active connector named "${name}".`)
    .exhaustive();
}

async function list(deps: ConnectorCliDeps, io: CliIo): Promise<number> {
  const rows = await deps.runInTx((tx) => deps.connectorStore.list(tx));
  if (rows.length === 0) {
    io.out("No connectors.");
    return 0;
  }
  io.out("name\tkind\tstatus\tcreated\trevoked");
  for (const row of rows) {
    io.out(
      [
        row.name,
        row.kind,
        row.status,
        row.createdAt.toISOString(),
        row.revokedAt?.toISOString() ?? "-",
      ].join("\t"),
    );
  }
  return 0;
}
