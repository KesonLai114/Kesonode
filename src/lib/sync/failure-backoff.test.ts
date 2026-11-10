import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_SETTINGS, getState, getSyncFailureState, syncBackoffRemaining,
  syncCooldownRemaining, noteSyncFailure, KEYS,
} from "@/lib/utils/storage";
import { HttpError } from "@/lib/utils/retry";
import type { SyncSettings, SyncState } from "@/lib/types";

// A backend that refuses to connect, which is what a wrong password, a revoked token and
// a folder that is gone all look like from inside the engine. `h.fail` also lets a test
// switch to a metered refusal (429) or to a working connection between cycles.
const h = vi.hoisted(() => ({
  connects: 0,
  fail: null as Error | null,
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    failedPeers: [],
    isConfigured: () => true,
    connect: async () => {
      h.connects++;
      if (h.fail) throw h.fail;
    },
    disconnect: async () => {},
    listFiles: async () => [],
    getFile: async () => null,
    putFile: async () => {},
    deleteFile: async () => {},
    upload: async () => {},
    downloadAll: async () => [],
    listVersions: async () => [],
    testConnection: async () => ({ ok: true, message: "" }),
  }),
}));

const { SyncEngine } = await import("@/lib/sync/sync-engine");

function settings(): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    active_backend: "webdav",
    backends: [{
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/kesonode", username: "u", password: "p" },
    }],
  };
}

function engine(onState: (s: SyncState) => void = () => {}): InstanceType<typeof SyncEngine> {
  return new SyncEngine(settings(), onState);
}

beforeEach(() => {
  h.connects = 0;
  h.fail = new HttpError(401, "WebDAV PROPFIND failed: 401");
});

describe("a failure that keeps repeating stops being retried every minute", () => {
  // A wrong password failed identically every cycle, forever: the status was rewritten,
  // a kept line was appended to the 200-entry Activity log, and every open popup was
  // woken — all to say what it had already said. Retrying is still right (that is how a
  // corrected password gets noticed), so the fix is a growing pause, not a stop.

  it("tries the first failure, and does not pause for it", async () => {
    const e = engine();
    expect(await e.sync()).toBe("ran");
    expect(h.connects).toBe(1);
    const f = await getSyncFailureState();
    expect(f.streak).toBe(1);
    expect(await syncBackoffRemaining()).toBe(0);
    expect((await getState()).status).toBe("error");
  });

  it("pauses automatic sync once the same failure repeats", async () => {
    const e = engine();
    await e.sync();
    await e.sync();
    expect(await syncBackoffRemaining()).toBeGreaterThan(0);

    // The third cycle does not reach the backend at all.
    expect(await e.sync()).toBe("backing-off");
    expect(h.connects).toBe(2);
    expect(e.isSyncing).toBe(false);
  });

  it("still lets 'Sync now' through, and restarts the count from it", async () => {
    // The manual press is the user's retry — the one thing someone does after fixing the
    // password — so it must never be gated, and it hands the streak back to zero.
    const e = engine();
    await e.sync();
    await e.sync();
    expect(await syncBackoffRemaining()).toBeGreaterThan(0);

    expect(await e.sync(undefined, { force: true })).toBe("ran");
    expect(h.connects).toBe(3);
    const f = await getSyncFailureState();
    expect(f.streak).toBe(1); // this cycle's failure, recorded fresh
    expect(await syncBackoffRemaining()).toBe(0);
  });

  it("drops the pause when settings are saved", async () => {
    const e = engine();
    await e.sync();
    await e.sync();
    expect(await syncBackoffRemaining()).toBeGreaterThan(0);

    await e.updateSettings({ ...settings(), sync_interval_seconds: 300 });
    expect(await syncBackoffRemaining()).toBe(0);
    expect(await e.sync()).toBe("ran"); // reaches the backend again
  });

  it("clears itself on a cycle that gets through", async () => {
    const e = engine();
    await e.sync();
    await e.sync();
    h.fail = null;
    expect(await e.sync(undefined, { force: true })).toBe("ran");
    expect((await getSyncFailureState()).streak).toBe(0);
  });

  it("does not park twice for a metered refusal, which has its own window", async () => {
    // A 429 gets the 30-minute cooldown; recording it as a repeated failure as well would
    // leave the shorter pause behind after the long one expired.
    h.fail = new HttpError(429, "HTTP 429");
    const e = engine();
    expect(await e.sync()).toBe("ran");
    expect(await syncCooldownRemaining()).toBeGreaterThan(0);
    expect((await getSyncFailureState()).streak).toBe(0);
    expect(await e.sync()).toBe("cooling-down");
  });

  it("stops rewriting the state once it is paused, and says the error only once", async () => {
    const seen: string[] = [];
    const e = engine((s) => seen.push(s.status));
    const writes = vi.spyOn(chrome.storage.local, "set");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await e.sync();
    await e.sync();
    const before = writes.mock.calls.filter(([items]) => KEYS.STATE in (items as object)).length;
    await e.sync(); // paused: nothing may be written

    const after = writes.mock.calls.filter(([items]) => KEYS.STATE in (items as object)).length;
    expect(after).toBe(before);
    expect(seen).toEqual(["syncing", "error", "syncing", "error"]);
    // Kept once (the first), said to the console afterwards.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.some(([, detail]) => String(detail).includes("Still failing"))).toBe(true);
    writes.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("the pause grows and is capped", () => {
  it("reaches the ceiling and stays there", async () => {
    const now = 1_000_000;
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const s = await noteSyncFailure("WebDAV PROPFIND failed: 401", now);
      last = s.until - now;
    }
    expect(last).toBe(15 * 60 * 1000);
  });
});
