import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const recorded: unknown = JSON.parse(
      await readFile(join(fixtureDir, "venice-models-image.json"), "utf-8"),
    );
    expect(recorded).toEqual({
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    });
  });

  it("passes a listing that isn't JSON back without recording it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>maintenance</html>", { status: 200 })),
    );

    const resp = await createVeniceFetch({ mode: "record", fixturePath: fixtureDir })(LISTING_URL, {
      method: "GET",
    });

    expect(await resp.text()).toBe("<html>maintenance</html>");
    expect(await readdir(fixtureDir)).toEqual([]);
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

describe("createVeniceFetch — image generation", () => {
  /** The fixture name the mock derives for a generate request (its `fixtureKey`). */
  function fixtureName(model: string, prompt: string): string {
    const hash = createHash("sha256")
      .update([model, prompt, "default", ""].join(":"))
      .digest("hex")
      .slice(0, 12);
    return `venice-${model.replace(/[^a-z0-9]/gi, "-")}-${hash}.json`;
  }

  const request = { method: "POST", body: JSON.stringify({ model: "chroma", prompt: "a fox" }) };
  const GENERATE_URL = `${VENICE_HOST}/api/v1/image/generate`;

  it("answers 503 with a re-record hint when the fixture is missing", async () => {
    const resp = await createVeniceFetch({ mode: "replay", fixturePath: fixtureDir })(
      GENERATE_URL,
      request,
    );

    expect(resp.status).toBe(503);
    expect(await resp.text()).toMatch(/no fixture for key/);
  });

  it("fails with the parse error, not a re-record hint, when the fixture is malformed", async () => {
    await writeFile(join(fixtureDir, fixtureName("chroma", "a fox")), '{"status": 200, "bo');

    await expect(
      createVeniceFetch({ mode: "replay", fixturePath: fixtureDir })(GENERATE_URL, request),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});
