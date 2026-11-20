import { describe, it, expect, vi, afterEach } from "vitest";
import { noteRecordedMove, resetMoveStormForTest } from "@/lib/handlers/bookmarks-handler";
import { KEYS } from "@/lib/utils/storage";

// A user reported bookmarks reordering overnight with nobody touching any browser.
// The move recorder only wrote to console (info), so Activity had no trace. A burst of
// hundreds of onMoved callbacks in one window is the signature of a programmatic
// rewrite (browser sync / another extension / a lost self-write echo). Exactly ONE
// audited line per storm must land in Activity — never one per move, which would
// evict the real warnings from the 200-entry ring.

async function audit(): Promise<Array<{ action: string; detail: string }>> {
  await new Promise((r) => setTimeout(r, 0));
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return (r[KEYS.AUDIT_LOG] as Array<{ action: string; detail: string }>) ?? [];
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetMoveStormForTest();
  await chrome.storage.local.clear();
});

describe("MoveStorm diagnostics", () => {
  it("stays silent for a handful of manual drags", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 24; i++) noteRecordedMove("url");
    expect(await audit()).toEqual([]);
  });

  it("writes ONE audited event when a burst crosses the threshold", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 200; i++) noteRecordedMove("url");
    const log = await audit();
    const storms = log.filter((e) => e.action === "MoveStorm");
    expect(storms).toHaveLength(1);
    expect(storms[0].detail).toContain("moves within");
    expect(storms[0].detail).toContain("not a manual drag");
  });

  it("does not repeat within the same window", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 500; i++) noteRecordedMove("folder");
    expect((await audit()).filter((e) => e.action === "MoveStorm")).toHaveLength(1);
  });
});
