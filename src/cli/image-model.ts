/**
 * `cogmo image-model <command>` — manage `image_models` catalog rows post-setup.
 *
 * Mirrors `cogmo model` (LLM models) but for image generation. Each row
 * binds a provider to a (name, model-string, description, capabilities)
 * tuple. The LLM sees `name` in its tool description; the provider API
 * sees `model_string`.
 *
 * `userSelectable` defaults to true — pass `--no-selectable` to stage
 * experimental or deprecated rows that stay in the DB but don't appear in
 * the `generate_image` tool's `model` enum.
 */

import type { AgentStore } from "../agent/store/index.js";
import type { ImageModelCapabilities } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";

const ALLOWED_RATIOS: ReadonlyArray<NonNullable<ImageModelCapabilities["aspectRatios"]>[number]> = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "9:21",
];

const USAGE = `Usage: cogmo image-model <command> [args]

Commands:
  add <name> --provider <name> --model-string <id> --description "<text>"
              [--ratios 1:1,16:9,...] [--seed] [--no-selectable]

              Register an image model. \`name\` is the LLM-facing key
              (must be globally unique — convention: <provider>/<slug>).
              \`model-string\` is what's sent to the provider API.
              \`description\` shows up in the tool's per-model hint line.
              \`ratios\` is a comma-separated list of supported aspect
              ratios; omit for fixed-size models. \`--seed\` advertises
              that this model honors the seed parameter.

  list [--provider <name>] [--all]
              Show catalog rows. Default lists user-selectable models only;
              \`--all\` includes hidden rows.

  remove <name>
              Delete a single image model by its LLM-facing name.
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface ImageModelCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

export async function runImageModelCli(
  argv: readonly string[],
  deps: ImageModelCliDeps,
  io: CliIo = CONSOLE_IO,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "add":
        return await addModelCmd(rest, deps, io);
      case "list":
        return await listModels(rest, deps, io);
      case "remove":
        return await removeModel(rest, deps, io);
      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    io.err(`Error: ${(err as Error).message}`);
    return 2;
  }
}

async function addModelCmd(
  args: readonly string[],
  deps: ImageModelCliDeps,
  io: CliIo,
): Promise<number> {
  const [name, ...flagArgs] = args;
  if (!name) {
    io.err("Usage: cogmo image-model add <name> --provider <name> --model-string <id> ...");
    return 2;
  }
  const opts = parseFlags(flagArgs);
  // Narrow required flag values into local consts so downstream call sites
  // don't need `!` non-null assertions (Biome lints `noNonNullAssertion` in
  // non-test files). Each check exits early before subsequent uses.
  const providerName = opts.provider;
  if (!providerName) {
    io.err("--provider is required");
    return 2;
  }
  const modelString = opts.modelString;
  if (!modelString) {
    io.err("--model-string is required");
    return 2;
  }
  const description = opts.description;
  if (!description) {
    io.err("--description is required (the LLM reads this at every turn)");
    return 2;
  }

  const provider = await deps.runInTx((tx) =>
    deps.agentStore.findImageProviderByName(tx, providerName),
  );
  if (!provider) {
    io.err(
      `No image provider named "${providerName}". Run \`cogmo image-provider list\` to see options.`,
    );
    return 1;
  }

  // Build capabilities — only include fields the operator opted into so the
  // Zod validator on the JSONB column doesn't store empty arrays.
  const capabilities: ImageModelCapabilities = {
    ...(opts.ratios && { aspectRatios: opts.ratios }),
    ...(opts.seed === true && { seed: true }),
  };

  try {
    const { id } = await deps.runInTx((tx) =>
      deps.agentStore.createImageModel(tx, {
        providerId: provider.id,
        name,
        modelString,
        description,
        capabilities,
        userSelectable: opts.userSelectable,
      }),
    );
    io.out(`Added image model "${name}" (id=${id}, provider=${provider.name}).`);
    io.out("Restart `cogmo serve` for the change to take effect.");
    return 0;
  } catch (err) {
    io.err(`Failed to add image model: ${(err as Error).message}`);
    return 1;
  }
}

async function listModels(
  args: readonly string[],
  deps: ImageModelCliDeps,
  io: CliIo,
): Promise<number> {
  const opts = parseFlags(args);
  const rows = await deps.runInTx((tx) =>
    deps.agentStore.listImageModelsWithProvider(tx, {
      // `--all` switches to "show every row including hidden ones"; default
      // matches the bootstrap filter so operators see the same catalog the
      // LLM does unless they ask otherwise.
      userSelectableOnly: !opts.all,
    }),
  );
  const filtered = opts.provider ? rows.filter((r) => r.provider.name === opts.provider) : rows;
  if (filtered.length === 0) {
    io.out("(no image models)");
    return 0;
  }
  io.out("name\tprovider\tmodel_string\tratios\tseed\tselectable");
  for (const row of filtered) {
    const ratios = row.capabilities.aspectRatios?.join(",") ?? "-";
    const seed = row.capabilities.seed === true ? "yes" : "no";
    io.out(
      [
        row.name,
        row.provider.name,
        row.modelString,
        ratios,
        seed,
        row.userSelectable ? "yes" : "no",
      ].join("\t"),
    );
  }
  return 0;
}

async function removeModel(
  args: readonly string[],
  deps: ImageModelCliDeps,
  io: CliIo,
): Promise<number> {
  const [name] = args;
  if (!name) {
    io.err("Usage: cogmo image-model remove <name>");
    return 2;
  }
  const rows = await deps.runInTx((tx) => deps.agentStore.listImageModels(tx));
  const target = rows.find((r) => r.name === name);
  if (!target) {
    io.err(`No image model named "${name}".`);
    return 1;
  }
  await deps.runInTx((tx) => deps.agentStore.deleteImageModel(tx, target.id));
  io.out(`Removed image model "${name}".`);
  io.out("Restart `cogmo serve` for the change to take effect.");
  return 0;
}

interface ParsedFlags {
  provider: string | undefined;
  modelString: string | undefined;
  description: string | undefined;
  ratios: NonNullable<ImageModelCapabilities["aspectRatios"]> | undefined;
  seed: boolean | undefined;
  userSelectable: boolean;
  all: boolean;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const out: ParsedFlags = {
    provider: undefined,
    modelString: undefined,
    description: undefined,
    ratios: undefined,
    seed: undefined,
    userSelectable: true,
    all: false,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--provider":
        out.provider = takeValue(args, i, flag);
        i++;
        break;
      case "--model-string":
        out.modelString = takeValue(args, i, flag);
        i++;
        break;
      case "--description":
        out.description = takeValue(args, i, flag);
        i++;
        break;
      case "--ratios":
        out.ratios = parseRatios(takeValue(args, i, flag));
        i++;
        break;
      case "--seed":
        out.seed = true;
        break;
      case "--no-selectable":
        out.userSelectable = false;
        break;
      case "--all":
        out.all = true;
        break;
      default:
        // Unknown flag — throw rather than swallow. `--ratio` (singular)
        // silently dropping would register a fixed-size model that the
        // operator expected to support ratios; the surprise is bad enough
        // to outweigh shell-level forgiveness. Caught by the outer
        // try/catch in `runImageModelCli` → rc=2.
        throw new Error(
          `Unknown flag "${flag}". Run \`cogmo image-model --help\` for accepted flags.`,
        );
    }
  }
  return out;
}

function takeValue(args: readonly string[], i: number, flag: string | undefined): string {
  const next = args[i + 1];
  if (next === undefined) {
    throw new Error(`${flag ?? "flag"} requires a value`);
  }
  if (next.startsWith("--")) {
    throw new Error(`${flag ?? "flag"} requires a value (got next flag "${next}" instead)`);
  }
  return next;
}

function parseRatios(value: string): NonNullable<ImageModelCapabilities["aspectRatios"]> {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const validated: NonNullable<ImageModelCapabilities["aspectRatios"]> = [];
  for (const part of parts) {
    const match = ALLOWED_RATIOS.find((r) => r === part);
    if (!match) {
      throw new Error(`--ratios got "${part}"; expected one of ${ALLOWED_RATIOS.join(", ")}`);
    }
    validated.push(match);
  }
  if (validated.length === 0) {
    throw new Error("--ratios got an empty list");
  }
  return validated;
}
