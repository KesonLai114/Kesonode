import { describe, it, expect, beforeEach } from "vitest";
import {
  guardEntries,
  evaluateLocalDrift,
  resetGuardState,
  GUARD_ABSOLUTE_FLOOR,
  GUARD_CHURN_ROUNDS,
  GUARD_IMMEDIATE_FLOOR,
} from "./change-guard";
import { getGuardState } from "@/lib/utils/storage";
import type { SyncBookmark } from "@/lib/types";

/**
 * The local change guard's decisions, without a sync around them.
 *
 * What is protected is the SENDING side: a browser's own sync (or a runaway extension)
 * can keep rewriting this device's tree, and before the guard every intermediate state
 * went out to all peers. The guard must NOT hold up a single ordinary bulk edit —
 * that is the whole reason it counts consecutive changing cycles rather than one big
 * diff. `test/setup.ts` clears chrome.storage.local before each test.
 */

/** One bar root holding `urls`. Titles follow the URL, not the array position, so two
 * trees sharing a bookmark agree about it. */
function tree(urls: string[], tag = "T"): SyncBookmark[] {
  return [
    {
      id: "0", parentId: null, title: "", dateAdded: 0,
      children: [
        {
          id: "1", parentId: "0", title: "Bookmarks bar", rootKind: "bar", dateAdded: 0,
          children: urls.map((url, i) => ({
            id: `n${i}`, parentId: "1",
            title: `${tag}${/site(\d+)/.exec(url)?.[1] ?? i}`,
            url, dateAdded: 1,
          })),
        },
      ],
    },
  ];
}

const urls = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `https://site${from + i}.example/`);

/** A tree that keeps a stable core but replaces its whole tail every cycle. */
const churnTree = (cycle: number): SyncBookmark[] =>
  tree([...urls(0, 30), ...urls(1000 + cycle * 30, 1030 + cycle * 30)]);

beforeEach(async () => {
  await resetGuardState();
});

describe("guardEntries", () => {
  it("keys a bookmark by root kind, folder path, title and canonical URL", () => {
    const entries = guardEntries(tree(["https://a.example", "https://b.example/"]));
    expect(entries).toHaveLength(2);
    // The trailing slash on an empty path is normalized; the rest of the URL is not.
    expect(entries.some((e) => e.includes("https://a.example/"))).toBe(true);
    expect(entries.every((e) => e.startsWith("bar\u0000"))).toBe(true);
  });

  it("is stable under folder enumeration order and counts a rename", () => {
    const a = tree(["https://a.example/", "https://b.example/"]);
    const reordered: SyncBookmark[] = [
      {
        ...a[0],
        children: [{ ...a[0].children![0], children: [...a[0].children![0].children!].reverse() }],
      },
    ];
    expect(guardEntries(reordered)).toEqual(guardEntries(a));
    expect(guardEntries(tree(["https://a.example/"], "Renamed"))).not.toEqual(
      guardEntries(tree(["https://a.example/"]))
    );
  });

  it("does not count deleted placeholders or empty folders", () => {
    const t = tree(["https://a.example/"]);
    t[0].children![0].children!.push({
      id: "empty", parentId: "1", title: "Empty", dateAdded: 1, children: [],
    });
    t[0].children![0].children!.push({
      id: "gone", parentId: "1", title: "Gone", url: "https://gone.example/",
      dateAdded: 1, _deleted: true,
    });
    expect(guardEntries(t)).toEqual(guardEntries(tree(["https://a.example/"])));
  });
});

describe("evaluateLocalDrift", () => {
  it("establishes the previous tree on first sight and never holds a joining device", async () => {
    const verdict = await evaluateLocalDrift(tree(urls(0, 200)));
    expect(verdict).toMatchObject({ hold: false, firstSighting: true, changed: 0 });
    expect((await getGuardState()).lastEntries).toHaveLength(200);
  });

  it("lets ordinary editing straight through", async () => {
    await evaluateLocalDrift(tree(urls(0, 30)));
    const verdict = await evaluateLocalDrift(tree([...urls(0, 30), ...urls(100, 103)]));
    expect(verdict).toMatchObject({ hold: false, changed: 3, cap: GUARD_ABSOLUTE_FLOOR, unstableRounds: 0 });
  });

  it("does NOT hold a single bulk deletion — that is one ordinary user action", async () => {
    await evaluateLocalDrift(tree(urls(0, 50)));
    const verdict = await evaluateLocalDrift(tree(urls(40, 50)));
    expect(verdict).toMatchObject({ hold: false, changed: 40, unstableRounds: 1 });
  });

  it("holds after several consecutive large-change cycles that never settle", async () => {
    await evaluateLocalDrift(tree(urls(0, 30)));
    for (let c = 1; c < GUARD_CHURN_ROUNDS; c++) {
      const verdict = await evaluateLocalDrift(churnTree(c));
      expect(verdict.hold).toBe(false);
      expect(verdict.unstableRounds).toBe(c);
    }
    const held = await evaluateLocalDrift(churnTree(GUARD_CHURN_ROUNDS));
    expect(held).toMatchObject({ hold: true, unstableRounds: GUARD_CHURN_ROUNDS });
  });

  it("clears the hold on the first quiet cycle, with no user action", async () => {
    await evaluateLocalDrift(tree(urls(0, 30)));
    for (let c = 1; c <= GUARD_CHURN_ROUNDS; c++) await evaluateLocalDrift(churnTree(c));
    const quiet = churnTree(GUARD_CHURN_ROUNDS);
    const verdict = await evaluateLocalDrift(quiet);
    expect(verdict).toMatchObject({ hold: false, changed: 0, unstableRounds: 0 });
    expect((await getGuardState()).unstableRounds).toBe(0);
  });

  it("never settles a tree that keeps changing — the loop stays contained", async () => {
    await evaluateLocalDrift(tree(urls(0, 30)));
    for (let c = 1; c <= GUARD_CHURN_ROUNDS; c++) await evaluateLocalDrift(churnTree(c));
    for (let c = GUARD_CHURN_ROUNDS + 1; c <= 8; c++) {
      expect((await evaluateLocalDrift(churnTree(c))).hold).toBe(true);
    }
  });

  it("holds one enormous rewrite immediately", async () => {
    await evaluateLocalDrift(tree(urls(0, 10)));
    const verdict = await evaluateLocalDrift(tree(urls(0, 10 + GUARD_IMMEDIATE_FLOOR)));
    expect(verdict).toMatchObject({ hold: true, immediate: true, changed: GUARD_IMMEDIATE_FLOOR });
    // Still self-healing: one quiet cycle is enough.
    expect((await evaluateLocalDrift(tree(urls(0, 10 + GUARD_IMMEDIATE_FLOOR)))).hold).toBe(false);
  });

  it("uses a proportional cap so a large tree is not held up by a small import", async () => {
    await evaluateLocalDrift(tree(urls(0, 1000)));
    const verdict = await evaluateLocalDrift(tree(urls(0, 1100)));
    expect(verdict).toMatchObject({ hold: false, changed: 100, cap: 300, unstableRounds: 0 });
  });
});

describe("resetGuardState", () => {
  it("starts over on the next cycle", async () => {
    await evaluateLocalDrift(tree(urls(0, 30)));
    await resetGuardState();
    expect((await evaluateLocalDrift(tree(urls(0, 5)))).firstSighting).toBe(true);
  });
});
