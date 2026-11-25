import { describe, it, expect, vi, afterEach } from "vitest";
import {
  noteRecordedMove, resetMoveStormForTest, forgetMoveStormCacheForTest, isMoveSuppressed,
} from "@/lib/handlers/bookmarks-handler";
import { KEYS, getMoveStormState } from "@/lib/utils/storage";

// A user reported bookmarks reordering overnight with nobody touching any browser.
// The move recorder only wrote to console (info), so Activity had no trace. A burst of
// hundreds of onMoved callbacks in one quiet-gap-delimited burst is the signature of a
// programmatic rewrite (browser sync / another extension / a lost self-write echo).
// Exactly ONE audited line per storm must land in Activity — never one per move.

async function audit(): Promise<Array<{ action: string; detail: string }>> {
  await new Promise((r) => setTimeout(r, 0));
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return (r[KEYS.AUDIT_LOG] as Array<{ action: string; detail: string }>) ?? [];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await resetMoveStormForTest();
  await chrome.storage.local.clear();
});

describe("MoveStorm diagnostics", () => {
  it("stays silent for a handful of manual drags", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 24; i++) await noteRecordedMove("url");
    expect(await audit()).toEqual([]);
  });

  it("writes ONE audited event when a burst crosses the threshold", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 200; i++) await noteRecordedMove("url");
    const log = await audit();
    const storms = log.filter((e) => e.action === "MoveStorm");
    expect(storms).toHaveLength(1);
    expect(storms[0].detail).toContain("moves within");
    expect(storms[0].detail).toContain("not a manual drag");
  });

  it("does not repeat within the same burst", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 500; i++) await noteRecordedMove("folder");
    expect((await audit()).filter((e) => e.action === "MoveStorm")).toHaveLength(1);
  });

  it("survives an MV3 worker restart: persisted span, no duplicate audit line", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 25; i++) await noteRecordedMove("url");
    now += 1_000; // still inside the same burst
    forgetMoveStormCacheForTest();

    const state = await getMoveStormState();
    expect(state.spans.some((s) => s.flagged)).toBe(true);
    for (let i = 0; i < 25; i++) await noteRecordedMove("url");
    expect((await audit()).filter((e) => e.action === "MoveStorm")).toHaveLength(1);
  });

  it("never merges two unrelated storms into one ever-growing time span", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = now;
    for (let i = 0; i < 25; i++) await noteRecordedMove("url");
    expect(isMoveSuppressed(first)).toBe(true);

    // A single manual drag an hour later is NOT part of the old storm.
    now += 3_600_000;
    const manual = now;
    await noteRecordedMove("url");
    expect(isMoveSuppressed(manual)).toBe(false);
    expect(isMoveSuppressed(first)).toBe(true);

    // Then a second, unrelated storm. Both spans coexist; neither expands the other.
    for (let i = 0; i < 24; i++) await noteRecordedMove("url");
    expect(isMoveSuppressed(manual)).toBe(true);
    expect(isMoveSuppressed(first)).toBe(true);
    expect((await audit()).filter((e) => e.action === "MoveStorm")).toHaveLength(2);
  });
});
