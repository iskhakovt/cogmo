import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVeniceFetch, VENICE_HOST } from "./venice-mock.js";

const LISTING_URL = `${VENICE_HOST}/api/v1/models?type=image`;

let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "venice-mock-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("createVeniceFetch — models listing", () => {
  it("replays the committed listing fixture for its type", async () => {
    const body = { object: "list", type: "image", data: [{ id: "chroma" }] };
    await writeFile(
      join(fixtureDir, "venice-models-image.json"),
      JSON.stringify({ status: 200, headers: { "Content-Type": "application/json" }, body }),
    );

    const resp = await createVeniceFetch({ mode: "replay", fixturePath: fixtureDir })(LISTING_URL, {
      method: "GET",
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(body);
  });

  it("answers 503 with a re-record hint when the fixture is missing", async () => {
    const resp = await createVeniceFetch({ mode: "replay", fixturePath: fixtureDir })(LISTING_URL, {
      method: "GET",
    });

    expect(resp.status).toBe(503);
    expect(await resp.text()).toMatch(/no fixture for the models listing \(type=image\)/);
  });

  it("fails with the parse error, not a re-record hint, when the fixture is malformed", async () => {
    await writeFile(join(fixtureDir, "venice-models-image.json"), '{"status": 200, "bo');

    await expect(
      createVeniceFetch({ mode: "replay", fixturePath: fixtureDir })(LISTING_URL, {
        method: "GET",
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it("records a successful listing", async () => {
    const body = { object: "list", type: "image", data: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );

    const resp = await createVeniceFetch({ mode: "record", fixturePath: fixtureDir })(LISTING_URL, {
      method: "GET",
    });

    expect(await resp.json()).toEqual(body);
    expect(await readdir(fixtureDir)).toEqual(["venice-models-image.json"]);
  });

  it("passes a failed listing back without recording it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    const resp = await createVeniceFetch({ mode: "record", fixturePath: fixtureDir })(LISTING_URL, {
      method: "GET",
    });

    expect(resp.status).toBe(401);
    expect(await readdir(fixtureDir)).toEqual([]);
  });
});
