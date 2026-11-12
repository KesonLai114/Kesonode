import { describe, it, expect, vi } from "vitest";
import {
  buildCleanupReport,
  checkDeadLinks,
  duplicateRemovalPlan,
  findDuplicateGroups,
} from "@/lib/cleanup";
import type { FlatBookmark } from "@/lib/handlers/reading-list-handler";

function item(id: string, url: string, dateAdded = 1, title = id, folder = "bar"): FlatBookmark {
  return { id, title, url, folder, dateAdded };
}

describe("findDuplicateGroups", () => {
  it("groups URLs that differ only by trailing slash or case", () => {
    const groups = findDuplicateGroups([
      item("a", "https://Dup.com"),
      item("b", "https://dup.com/"),
      item("c", "https://dup.com"),
      item("d", "https://other.com/"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].url).toBe("https://dup.com/");
    expect(groups[0].items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("sorts the biggest group first and ignores singletons", () => {
    const groups = findDuplicateGroups([
      item("a", "https://one.com/"),
      item("b", "https://two.com/"),
      item("c", "https://two.com/"),
      item("d", "https://three.com/"),
      item("e", "https://three.com/"),
      item("f", "https://three.com/"),
    ]);

    expect(groups.map((g) => g.items.length)).toEqual([3, 2]);
  });

  it("keeps each copy's folder and date for the confirmation list", () => {
    const groups = findDuplicateGroups([
      item("a", "https://dup.com/", 1, "Old", "bar / Work"),
      item("b", "https://dup.com/", 2, "New", "bar"),
    ]);

    expect(groups[0].items).toEqual([
      { id: "a", title: "Old", folder: "bar / Work", dateAdded: 1 },
      { id: "b", title: "New", folder: "bar", dateAdded: 2 },
    ]);
  });
});

describe("duplicateRemovalPlan", () => {
  const groups = findDuplicateGroups([
    item("old", "https://dup.com/", 100),
    item("new", "https://dup.com/", 200),
    item("tie-b", "https://tie.com/", 300),
    item("tie-a", "https://tie.com/", 300),
  ]);

  it("keeps the oldest copy by default", () => {
    expect(duplicateRemovalPlan(groups).sort()).toEqual(["new", "tie-b"]);
  });

  it("can keep the newest instead", () => {
    // A date tie still breaks by id, so the same copy wins whichever order the rows
    // happened to arrive in.
    expect(duplicateRemovalPlan(groups, "newest").sort()).toEqual(["old", "tie-b"]);
  });

  it("breaks a date tie by id so the plan is deterministic", () => {
    // Two runs of the same tree must remove the same copy.
    const first = duplicateRemovalPlan(groups);
    const second = duplicateRemovalPlan([...groups].reverse());
    expect(first.sort()).toEqual(second.sort());
  });
});

describe("checkDeadLinks", () => {
  const links = [
    item("a", "https://alive.example/"),
    item("b", "https://gone.example/"),
    item("c", "chrome://settings/"),
  ];

  it("reports only HTTP error statuses, and only for http(s) links", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      return new Response(null, { status: href.includes("gone") ? 404 : 200 });
    }) as unknown as typeof fetch;

    const scan = await checkDeadLinks(links, { fetchImpl });
    expect(scan.dead).toEqual([
      { id: "b", title: "b", url: "https://gone.example/", status: 404 },
    ]);
    expect(scan.checked).toBe(2);
    expect(scan.unchecked).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // chrome:// never leaves the browser
  });

  it.each([401, 403, 429, 500, 503])(
    "does not call a %i a dead link",
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
      const scan = await checkDeadLinks([item("a", "https://alive.example/")], { fetchImpl });
      expect(scan.dead).toEqual([]);
      expect(scan.checked).toBe(1);
    },
  );

  it("retries with GET when a server refuses HEAD", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 405 })
        : new Response(null, { status: 410 })
    ) as unknown as typeof fetch;

    const scan = await checkDeadLinks([item("h", "https://no-head.example/")], { fetchImpl });
    expect(scan.dead).toEqual([
      { id: "h", title: "h", url: "https://no-head.example/", status: 410 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not report a timeout as a dead link", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;

    const scan = await checkDeadLinks([item("t", "https://slow.example/")], { fetchImpl, timeoutMs: 10 });
    expect(scan.dead).toEqual([]);
  });

  it("checks at most 300 links per run and says how many it skipped", async () => {
    const many = Array.from({ length: 350 }, (_, i) => item(`i${i}`, `https://i${i}.example/`));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const scan = await checkDeadLinks(many, { fetchImpl, concurrency: 10 });
    expect(fetchImpl).toHaveBeenCalledTimes(300);
    expect(scan.checked).toBe(300);
    expect(scan.unchecked).toBe(50);
  });

  it("stops starting probes at the time limit instead of running past the worker's life", async () => {
    const many = Array.from({ length: 50 }, (_, i) => item(`i${i}`, `https://i${i}.example/`));
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchImpl = vi.fn(async () => {
      clock += 1000;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const scan = await checkDeadLinks(many, { fetchImpl, concurrency: 1, maxDurationMs: 5000 });
      expect(scan.checked).toBeLessThan(many.length);
      expect(scan.unchecked).toBe(many.length - scan.checked);
    } finally {
      now.mockRestore();
    }
  });
});

describe("buildCleanupReport", () => {
  it("records what was scanned and whether the network check ran", () => {
    const items = [item("a", "https://dup.com/"), item("b", "https://dup.com/"), item("c", "https://c.com/")];
    const report = buildCleanupReport(items, { dead: [], checked: 2, unchecked: 1 });

    expect(report.scanned).toBe(3);
    expect(report.dead_checked).toBe(true);
    expect(report.dead_probed).toBe(2);
    expect(report.dead_unchecked).toBe(1);
    expect(report.duplicates).toHaveLength(1);
    expect(report.dead).toEqual([]);
  });

  it("leaves the dead-link fields absent when the network check was not run", () => {
    const report = buildCleanupReport([item("a", "https://a.com/")], null);

    expect(report.dead_checked).toBe(false);
    expect(report).not.toHaveProperty("dead_probed");
    expect(report).not.toHaveProperty("dead_unchecked");
  });
});
