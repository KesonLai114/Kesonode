import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { resetGuardState, GUARD_ABSOLUTE_FLOOR, GUARD_CHURN_ROUNDS } from "./change-guard";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "@/lib/utils/storage";
import type { IBackend, SyncPacket, DataType, SyncState, SyncSettings } from "@/lib/types";

/**
 * The guard wired into a real sync cycle.
 *
 * `syncType` is driven directly (as three-devices.test.ts does) so no backend config or
 * sync lock is needed. `cycle()` repeats the per-cycle field reset that `sync()` does.
 * No peers are present, which routes every case through the "no peers → publish" branch;
 * the point is the single upload gate, which all three branches share.
 */

class FakeBackend implements IBackend {
  readonly type = "github" as const;
  uploads: SyncPacket[] = [];
  pulls = 0;
  private blobs = new Map<string, string>();
  isConfigured(): boolean { return true; }
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  testConnection(): Promise<{ ok: boolean; message: string }> {
    return Promise.resolve({ ok: true, message: "" });
  }
  upload(packet: SyncPacket): Promise<void> {
    this.uploads.push(packet);
    this.blobs.set(`konode_${packet.data_type}_${packet.device_id}.json`, JSON.stringify(packet));
    return Promise.resolve();
  }
  downloadAll(): Promise<SyncPacket[]> { this.pulls++; return Promise.resolve([]); }
  putFile(name: string, content: string): Promise<void> { this.blobs.set(name, content); return Promise.resolve(); }
  getFile(name: string): Promise<string | null> { return Promise.resolve(this.blobs.get(name) ?? null); }
  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()].filter((n) => n.startsWith(prefix)));
  }
  deleteFile(name: string): Promise<void> { this.blobs.delete(name); return Promise.resolve(); }
}

type EnginePrivate = {
  syncType(dataType: DataType, backend: IBackend, state: SyncState): Promise<void>;
  guardHoldThisSync: boolean;
  guardNoticeThisSync: SyncState["guard_notice"];
};
const priv = (engine: SyncEngine): EnginePrivate => engine as unknown as EnginePrivate;

function makeEngine(): SyncEngine {
  const settings: SyncSettings = {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    conflict_strategy: "lww",
    encryption_enabled: false,
  };
  return new SyncEngine(settings, () => {});
}

/** Bookmarks appearing with NO extension event, the way a browser's own sync pushes them in. */
async function externalBatch(from: number, to: number): Promise<void> {
  for (let i = from; i < to; i++) {
    await chrome.bookmarks.create({ parentId: "1", title: `B${i}`, url: `https://site${i}.example/` });
  }
}

/** A wave that replaces a third of the tree without firing any extension event. The
 * tree stays the same size, so the proportional cap cannot grow out of the churn. */
async function replaceBatch(count: number, from: number): Promise<void> {
  const [root] = await chrome.bookmarks.getTree();
  const children = root.children![0].children ?? [];
  for (const node of children.slice(0, count)) await chrome.bookmarks.remove(node.id);
  await externalBatch(from, from + count);
}

async function cycle(engine: SyncEngine, backend: IBackend): Promise<void> {
  priv(engine).guardHoldThisSync = false;
  priv(engine).guardNoticeThisSync = null;
  await priv(engine).syncType("bookmarks", backend, DEFAULT_STATE);
}

beforeEach(async () => {
  await resetGuardState();
});

describe("local change guard in a sync cycle", () => {
  it("does not delay the user's own bulk add or bulk delete", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await externalBatch(0, 30);
    await cycle(engine, backend);
    expect(backend.uploads).toHaveLength(1);

    // One large batch, whether it came from the user or from the browser's own sync:
    // a single cycle of churn is not a loop, and must reach the peers right away.
    await externalBatch(100, 100 + GUARD_ABSOLUTE_FLOOR + 5);
    await cycle(engine, backend);
    expect(backend.uploads).toHaveLength(2);
    expect(priv(engine).guardNoticeThisSync).toBeNull();

    const treeNodes = await chrome.bookmarks.getTree();
    const children = treeNodes[0].children![0].children ?? [];
    for (const node of children.slice(0, 30)) await chrome.bookmarks.remove(node.id);
    await cycle(engine, backend);
    expect(backend.uploads).toHaveLength(3);
    expect(priv(engine).guardNoticeThisSync).toBeNull();
  });

  it("holds publishing once the tree has changed heavily on consecutive cycles", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await externalBatch(0, 30);
    await cycle(engine, backend); // first sight
    expect(backend.uploads).toHaveLength(1);

    for (let c = 1; c < GUARD_CHURN_ROUNDS; c++) {
      await externalBatch(c * 100, c * 100 + 30);
      await cycle(engine, backend);
      expect(backend.uploads).toHaveLength(c + 1); // observation cycles still publish
    }

    await externalBatch(GUARD_CHURN_ROUNDS * 100, GUARD_CHURN_ROUNDS * 100 + 30);
    await cycle(engine, backend);
    expect(backend.uploads).toHaveLength(GUARD_CHURN_ROUNDS); // held: nothing new published
    expect(priv(engine).guardNoticeThisSync).toMatchObject({ unstableRounds: GUARD_CHURN_ROUNDS });
    // Peers are still pulled and merged — only OUR publishing is on hold.
    expect(backend.pulls).toBe(GUARD_CHURN_ROUNDS + 1);

    // One quiet cycle clears the incident by itself: no button, no approval.
    await cycle(engine, backend);
    expect(backend.uploads).toHaveLength(GUARD_CHURN_ROUNDS + 1);
    expect(priv(engine).guardNoticeThisSync).toBeNull();
  });

  it("never publishes a tree that keeps changing every cycle", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await externalBatch(0, 30);
    await cycle(engine, backend); // first sight
    for (let c = 1; c <= GUARD_CHURN_ROUNDS + 4; c++) {
      await replaceBatch(30, c * 100);
      await cycle(engine, backend);
      if (c >= GUARD_CHURN_ROUNDS) {
        // c=1 and c=2 were observation cycles and published; from c=3 on nothing more does.
        expect(backend.uploads).toHaveLength(GUARD_CHURN_ROUNDS);
      }
    }
  });

  it("does not hold up ordinary editing", async () => {
    const engine = makeEngine();
    const backend = new FakeBackend();
    await externalBatch(0, 30);
    await cycle(engine, backend);

    await externalBatch(100, 103);
    await cycle(engine, backend);
    expect(backend.uploads).toHaveLength(2);
    expect(priv(engine).guardNoticeThisSync).toBeNull();
  });
});
