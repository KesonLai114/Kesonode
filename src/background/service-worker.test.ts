import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMessage, ExtensionResponse, SyncSettings, SyncState } from "@/lib/types";
import type { SyncOutcome } from "@/lib/sync/sync-engine";
import {
  DEFAULT_SETTINGS, KEYS, getState, setState, startSyncCooldown, noteSyncFailure,
  syncCooldownRemaining, syncBackoffRemaining,
} from "@/lib/utils/storage";
import { BOOKMARK_ALARM, SYNC_ALARM } from "@/lib/utils/alarms";
import { logger } from "@/lib/utils/logger";

// Exercise the worker's real registered entry points, not exported scheduler helpers.
// Engine outcomes are scripted here; cooldown/backoff deadlines use real storage helpers.
const h = vi.hoisted(() => {
  // A STABLE class, not vi.fn().mockImplementation: the module factory is evaluated once,
  // so afterEach's restoreAllMocks() would permanently strip such an implementation and
  // every test after the first would get an engine whose sync() is undefined.
  class FakeEngine {
    sync = state.sync;
    updateSettings = state.updateSettings;
    get isSyncing(): boolean { return state.isSyncing; }
    constructor(_settings: unknown, broadcast: (next: SyncState) => void) { state.broadcast = broadcast; }
  }
  const state = {
    sync: vi.fn<(...args: unknown[]) => Promise<SyncOutcome>>(),
    updateSettings: vi.fn(),
    isSyncing: false,
    changed: (() => {}) as () => void,
    broadcast: ((_state: SyncState) => {}) as (next: SyncState) => void,
  };
  return Object.assign(state, { Engine: FakeEngine });
});
vi.mock("@/lib/sync/sync-engine", () => ({
  SyncEngine: h.Engine,
  explainSyncFailure: async (error: Error) => error.message,
}));
vi.mock("@/lib/handlers/bookmarks-handler", () => ({
  registerBookmarkListeners: (changed: () => void) => { h.changed = changed; },
  recordExclusionRelease: vi.fn(),
}));
vi.mock("@/lib/backends/abstract-backend", () => ({ createBackend: vi.fn() }));
vi.mock("@/lib/onboarding-draft", () => ({ clearExpiredDraft: async () => false }));
vi.mock("@/lib/sync/conflict-resolver", () => ({ openConflictFromNotification: vi.fn() }));
vi.mock("@/lib/utils/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), event: vi.fn() },
  setLoggerDebug: vi.fn(),
}));

const START = Date.parse("2026-11-10T00:00:00Z");
let alarms: Map<string, chrome.alarms.Alarm>;
let alarmListener: (alarm: chrome.alarms.Alarm) => Promise<void>;
let messageListener: (message: ExtensionMessage, sender: { id: string }) => Promise<ExtensionResponse>;

async function finishSuccessfully(): Promise<SyncOutcome> {
  const before = await getState();
  const after = await setState({
    status: "success", last_error: null, failed_types: [], guard_notice: null,
    sync_counts: { ...before.sync_counts, bookmarks: before.sync_counts.bookmarks + 1 },
  });
  h.broadcast(after);
  return "ran";
}

async function startWorker(): Promise<void> {
  vi.resetModules();
  await import("./service-worker");
  // GET_STATE awaits the same initialization promise as all other entry points.
  await messageListener({ type: "GET_STATE" }, { id: chrome.runtime.id });
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const bookmarkAlarm = () => alarms.get(BOOKMARK_ALARM);

async function fireNextAlarm(): Promise<void> {
  const pending = bookmarkAlarm();
  expect(pending).toBeDefined();
  await vi.advanceTimersByTimeAsync(Math.max(0, pending!.scheduledTime - Date.now()));
  const fired = bookmarkAlarm();
  expect(fired).toBeDefined();
  expect(fired!.scheduledTime).toBeLessThanOrEqual(Date.now());
  // Browser-owned alarms, not JS timers: firing advances periodic alarms, consumes
  // one-shots, and survives vi.clearAllTimers()/a fresh worker module below.
  if (fired!.periodInMinutes) {
    alarms.set(BOOKMARK_ALARM, {
      ...fired!, scheduledTime: Date.now() + fired!.periodInMinutes * 60_000,
    });
  } else {
    alarms.delete(BOOKMARK_ALARM);
  }
  await alarmListener(fired!);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.clearAllMocks();
  h.isSyncing = false;
  h.sync.mockReset().mockImplementation(finishSuccessfully);
  h.updateSettings.mockResolvedValue(undefined);
  alarms = new Map();
  vi.spyOn(chrome.alarms, "create").mockImplementation(async (name, info) => {
    alarms.set(name, {
      name,
      scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
      periodInMinutes: info.periodInMinutes,
    });
  });
  vi.spyOn(chrome.alarms, "get").mockImplementation(async (name: string) => alarms.get(name)!);
  // The real `clear` is overloaded (name?, callback); Vitest's mock typing cannot express
  // that shape, so the implementation is cast rather than contorted to match it.
  vi.spyOn(chrome.alarms, "clear").mockImplementation(
    (async (name: string) => { alarms.delete(name); }) as unknown as typeof chrome.alarms.clear,
  );
  Object.assign(chrome.alarms, {
    onAlarm: { addListener: (listener: typeof alarmListener) => { alarmListener = listener; } },
  });
  Object.assign(chrome.runtime, {
    onMessage: { addListener: (listener: typeof messageListener) => { messageListener = listener; } },
    sendMessage: vi.fn().mockResolvedValue(undefined),
  });
  await chrome.storage.local.set({
    [KEYS.SETTINGS]: {
      ...DEFAULT_SETTINGS, device_id: "test-device", device_label: "Test",
      auto_sync: false, sync_on_change: true, enabled_types: ["bookmarks"],
    },
  });
  await startWorker();
});

afterEach(() => {
  // Automatic bookmark attempts must NEVER acquire manual/force semantics.
  for (const args of h.sync.mock.calls) expect(args).toEqual([["bookmarks"]]);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bookmark-change scheduling with auto_sync disabled", () => {
  it("keeps the one-second debounce without postponing the backstop for a 500-event burst", async () => {
    expect(alarms.size).toBe(0); // initialization alone must not start an upload loop
    for (let i = 0; i < 500; i++) h.changed();
    await flush();
    expect(bookmarkAlarm()).toMatchObject({ scheduledTime: START + 30_000, periodInMinutes: 0.5 });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sync).not.toHaveBeenCalled();
    h.changed();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sync).not.toHaveBeenCalled();
    expect(bookmarkAlarm()?.scheduledTime).toBe(START + 30_000);
    expect(chrome.alarms.create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(bookmarkAlarm()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(alarms.has(SYNC_ALARM)).toBe(false);
  });

  it.each(["cooldown", "backoff"] as const)("resumes after persisted %s without another edit or periodic sync", async (window) => {
    if (window === "cooldown") await startSyncCooldown();
    else {
      await noteSyncFailure("offline");
      await noteSyncFailure("offline");
    }
    const remaining = window === "cooldown" ? await syncCooldownRemaining() : await syncBackoffRemaining();
    h.sync.mockImplementation(async () => {
      if (await syncCooldownRemaining()) return "cooling-down";
      if (await syncBackoffRemaining()) return "backing-off";
      return finishSuccessfully();
    });
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(bookmarkAlarm()?.scheduledTime).toBe(START + remaining);
    // Another edit in the window must not move its end further away.
    h.changed();
    await flush();
    expect(bookmarkAlarm()?.scheduledTime).toBe(START + remaining);
    vi.clearAllTimers();
    await startWorker();
    await vi.advanceTimersByTimeAsync(remaining - 1001);
    expect(h.sync).toHaveBeenCalledTimes(1);
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect((await getState()).sync_counts.bookmarks).toBe(1);
    expect(bookmarkAlarm()).toBeUndefined();
    expect(alarms.has(SYNC_ALARM)).toBe(false);
  });

  it("moves an existing alarm past both windows first encountered during sync", async () => {
    h.sync.mockImplementationOnce(async () => {
      await startSyncCooldown();
      await noteSyncFailure("offline");
      await noteSyncFailure("offline");
      await setState({ status: "error", failed_types: ["bookmarks"] });
      return "ran";
    });
    h.changed();
    await flush();
    expect(bookmarkAlarm()?.scheduledTime).toBe(START + 30_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bookmarkAlarm()?.scheduledTime).toBe(Date.now() + await syncCooldownRemaining());
    expect(bookmarkAlarm()!.scheduledTime).toBeGreaterThan(Date.now() + await syncBackoffRemaining());
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("retries a successful-looking guard hold and uploads the settled tree after a worker restart", async () => {
    h.sync.mockImplementationOnce(async () => {
      await setState({
        status: "success", failed_types: [],
        guard_notice: { at: new Date().toISOString(), changed: 500, cap: 500, unstableRounds: 1 },
      });
      return "ran";
    });
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bookmarkAlarm()?.periodInMinutes).toBe(0.5);
    expect((await getState()).sync_counts.bookmarks).toBe(0);
    vi.clearAllTimers();
    await startWorker();
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect((await getState()).guard_notice).toBeNull();
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it.each(["already-running", "throw", "bookmarks-failed", "cycle-failed"] as const)(
    "retains retries when both the fast path and the second attempt report %s",
    async (result) => {
      const unsuccessful = async (): Promise<SyncOutcome> => {
        if (result === "throw") throw new Error("storage interrupted");
        if (result === "already-running") return result;
        await setState({ status: "error", failed_types: result === "bookmarks-failed" ? ["bookmarks"] : [] });
        return "ran";
      };
      h.sync.mockImplementationOnce(unsuccessful).mockImplementationOnce(unsuccessful);
      h.changed();
      await vi.advanceTimersByTimeAsync(1000);
      expect(bookmarkAlarm()).toBeDefined();
      await fireNextAlarm();
      expect(h.sync).toHaveBeenCalledTimes(2);
      expect(bookmarkAlarm()).toBeDefined();
      await fireNextAlarm();
      expect(h.sync).toHaveBeenCalledTimes(3);
      expect(bookmarkAlarm()).toBeUndefined();
    },
  );

  it("keeps the backstop when the engine is still busy at the second attempt", async () => {
    h.isSyncing = true;
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    await fireNextAlarm();
    expect(h.sync).not.toHaveBeenCalled();
    expect(bookmarkAlarm()).toBeDefined();
    h.isSyncing = false;
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("survives eviction before the fast timer runs", async () => {
    h.changed();
    await flush();
    vi.clearAllTimers();
    await startWorker();
    expect(h.sync).not.toHaveBeenCalled();
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("upgrades a fired legacy one-shot before a busy attempt", async () => {
    alarms.set(BOOKMARK_ALARM, { name: BOOKMARK_ALARM, scheduledTime: START + 30_000 });
    h.isSyncing = true;
    await fireNextAlarm();
    expect(bookmarkAlarm()?.periodInMinutes).toBe(0.5);
    h.isSyncing = false;
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("does not acknowledge a new event while an earlier upload is completing", async () => {
    let finish!: (outcome: SyncOutcome) => void;
    h.sync.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    h.changed();
    // Its debounce expires while the old upload is still running.
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    finish(await finishSuccessfully());
    await flush();
    expect(bookmarkAlarm()).toBeDefined();
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("recreates the backstop when a new event arrives during asynchronous alarm clearing", async () => {
    let finishClear!: () => void;
    vi.mocked(chrome.alarms.clear).mockImplementationOnce(
      ((name: string) => new Promise<void>((resolve) => {
        finishClear = () => { alarms.delete(name); resolve(); };
      })) as unknown as typeof chrome.alarms.clear,
    );
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(finishClear).toBeDefined();
    h.changed();
    finishClear();
    await flush();
    expect(bookmarkAlarm()).toBeDefined();
    vi.clearAllTimers();
    await startWorker();
    await fireNextAlarm();
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("leaves first-sync-pending to the direction card instead of retrying forever", async () => {
    h.sync.mockImplementationOnce(async () => {
      await setState({ first_sync_pending: { at: new Date().toISOString(), peer_count: 1 } });
      return "first-sync-pending";
    });
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bookmarkAlarm()).toBeUndefined();
    // Even subsequent edits must not run the engine while the card is unanswered.
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it.each(["retention-log", "later-cycle-error", "other-type-error", "conflict"] as const)(
    "does not mistake %s for a failed bookmark upload",
    async (result) => {
      h.sync.mockImplementationOnce(async () => {
        await finishSuccessfully();
        if (result === "retention-log") logger.error("Retention", "could not delete old snapshots");
        if (result === "later-cycle-error") await setState({ status: "error", failed_types: [] });
        if (result === "other-type-error") await setState({ status: "error", failed_types: ["history"] });
        if (result === "conflict") await setState({ status: "conflict" });
        return "ran";
      });
      h.changed();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sync).toHaveBeenCalledTimes(1);
      expect(bookmarkAlarm()).toBeUndefined();
    },
  );

  it.each([
    { sync_on_change: false },
    { enabled_types: ["history"] },
  ] satisfies Partial<SyncSettings>[])("clears the alarm and debounce when saving %j", async (payload) => {
    h.changed();
    await flush();
    const response = await messageListener({ type: "SAVE_SETTINGS", payload }, { id: chrome.runtime.id });
    expect(response.type).toBe("OK");
    expect(bookmarkAlarm()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sync).not.toHaveBeenCalled();
  });

  it.each(["wake", "alarm"] as const)("clears stale retries on %s when bookmark sync was disabled elsewhere", async (entry) => {
    h.changed();
    await flush();
    vi.clearAllTimers();
    const stored = await chrome.storage.local.get(KEYS.SETTINGS);
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { ...stored[KEYS.SETTINGS], sync_on_change: false } });
    if (entry === "wake") await startWorker();
    else await fireNextAlarm();
    expect(h.sync).not.toHaveBeenCalled();
    expect(bookmarkAlarm()).toBeUndefined();
  });

  it("isolates rejected badge promises from a completed sync and state broadcast", async () => {
    vi.spyOn(chrome.action, "setBadgeBackgroundColor").mockRejectedValue(new Error("color unavailable"));
    vi.spyOn(chrome.action, "setBadgeText").mockRejectedValue(new Error("text unavailable"));
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect((await getState()).status).toBe("success");
    expect(bookmarkAlarm()).toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith("updateBadge", expect.stringContaining("color unavailable"));
    expect(logger.debug).toHaveBeenCalledWith("updateBadge", expect.stringContaining("text unavailable"));
  });
});

describe("the periodic sync alarm follows auto_sync", () => {
  it("does not sync when automatic sync is off, and removes the leftover alarm", async () => {
    // The setting can be turned off while an alarm event is already on its way (or the
    // clear that belongs to the save can fail), so the handler re-reads it rather than
    // trusting that an alarm could only exist while automatic sync was on.
    alarms.set(SYNC_ALARM, { name: SYNC_ALARM, scheduledTime: Date.now(), periodInMinutes: 1 });
    await alarmListener({ name: SYNC_ALARM, scheduledTime: Date.now() });
    expect(h.sync).not.toHaveBeenCalled();
    expect(alarms.has(SYNC_ALARM)).toBe(false);
  });

  it("clears an alarm left from before automatic sync was turned off", async () => {
    alarms.set(SYNC_ALARM, { name: SYNC_ALARM, scheduledTime: Date.now(), periodInMinutes: 1 });
    // A fresh worker runs init() again against the stored settings.
    await startWorker();
    expect(alarms.has(SYNC_ALARM)).toBe(false);
  });

  it("does not run the engine on a periodic tick while the first-sync card is unanswered", async () => {
    // The bookmark-change path already skips sync while a direction card is pending —
    // the card, not a timer, owns the decision. The periodic alarm must do the same:
    // otherwise every minute it runs sync(), which broadcasts syncing→idle and makes
    // an open popup flicker while the user is still deciding which side wins.
    await setState({ first_sync_pending: { at: new Date().toISOString(), peer_count: 2 } });
    await chrome.storage.local.set({
      [KEYS.SETTINGS]: {
        ...DEFAULT_SETTINGS, device_id: "test-device", device_label: "Test",
        auto_sync: true, sync_on_change: true, enabled_types: ["bookmarks"],
      },
    });
    await startWorker(); // re-init with auto_sync on
    alarms.set(SYNC_ALARM, { name: SYNC_ALARM, scheduledTime: Date.now(), periodInMinutes: 1 });
    await alarmListener({ name: SYNC_ALARM, scheduledTime: Date.now() });
    expect(h.sync).not.toHaveBeenCalled();
  });
});
