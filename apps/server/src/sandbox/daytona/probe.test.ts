import type { Daytona } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { daytonaHealthProbe } from "./probe.js";

interface ListedItem {
  id: string;
}

/**
 * Stand-in for `Daytona.list`'s lazy pager. `daytonaHealthProbe` touches
 * nothing else on the client, so a structural stub keeps the test on the
 * contracts that matter: which query goes out, and how far the probe
 * walks the result.
 */
function fakeDaytona(items: ReadonlyArray<ListedItem>): {
  daytona: Daytona;
  list: ReturnType<typeof vi.fn>;
  pulled: ListedItem[];
} {
  const pulled: ListedItem[] = [];
  const list = vi.fn((_query: unknown) =>
    (async function* () {
      for (const item of items) {
        pulled.push(item);
        yield item;
      }
    })(),
  );
  return { daytona: { list } as unknown as Daytona, list, pulled };
}

describe("daytonaHealthProbe", () => {
  it("asks for one page filtered on a label no sandbox carries", async () => {
    // The empty result is the whole point: `list()` hydrates every row it
    // yields with a second `getToolboxProxyUrl` request, and both callers
    // read a probe failure as a verdict on the API key — so a probe that
    // can match a row turns a reaped sandbox or a proxy-service outage
    // into "your key was rejected".
    const { daytona, list } = fakeDaytona([]);
    await daytonaHealthProbe(daytona);
    expect(list).toHaveBeenCalledWith({
      limit: 1,
      labels: { "cogmo.health-probe": "never-set" },
    });
  });

  it("stops at the first row — never drains the pager", async () => {
    // Belt to the filter's braces: even if the filter somehow matched,
    // the probe pulls one row and abandons the iterator rather than
    // paging (and hydrating) an entire account.
    const { daytona, pulled } = fakeDaytona([{ id: "sb-a" }, { id: "sb-b" }, { id: "sb-c" }]);
    await daytonaHealthProbe(daytona);
    expect(pulled).toEqual([{ id: "sb-a" }]);
  });

  it("propagates the list failure so callers can classify it", async () => {
    const list = vi.fn(() => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => Promise.reject(new Error("401 Unauthorized")),
    }));
    await expect(daytonaHealthProbe({ list } as unknown as Daytona)).rejects.toThrow(
      "401 Unauthorized",
    );
  });
});
