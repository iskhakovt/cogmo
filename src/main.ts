#!/usr/bin/env node

const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve":
    await import("./index.js");
    break;
  case "seed": {
    const { seed } = await import("./seed.js");
    await seed();
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: main.js [serve|seed]");
    process.exit(1);
}
