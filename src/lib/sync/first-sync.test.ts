import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS, getState, getFirstSync, setFirstSync,
  setLastUploadChecksum, exportSettingsBackup,
} from "@/lib/utils/storage";
import { sha256 } from "@/lib/crypto/encryption";
import type { SyncSettings, SyncPacket, SyncBookmark, BookmarkPayload } from "@/lib/types";

// sync() builds its own backend from the active config, so createBackend is mocked (the
// same shape devices.test.ts uses) instead of injecting a fake into syncType().
const h = vi.hoisted(() => ({
  blobs: new Map<string, string>(),
  uploads: [] as string[],
  listFails: false,
  peerFailures: [] as string[],
  deleteFails: false,
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    isConfigured: () => true,
    failedPeers: h.peerFailures,
    connect: async () => {},
    disconnect: async () => {},
    listFiles: async (prefix: string) => {
      if (h.listFails) throw new Error("503");
      return [...h.blobs.keys()].filter((n) => n.startsWith(prefix));
    },
    getFile: async (name: string) => h.blobs.get(name) ?? null,
    deleteFile: async (name: string) => {
      if (h.deleteFails) throw new Error("HTTP 503");
      h.blobs.delete(name);
    },
    putFile: async (name: string, content: string) => { h.blobs.set(name, content); },
    upload: async (p: SyncPacket) => {
      h.uploads.push(p.device_id);
      h.blobs.set(`konode_${p.data_type}_${p.device_id}.json`, JSON.stringify(p));
    },
    downloadAll: async (dataType: string, excludeDeviceId?: string) =>
      [...h.blobs.values()]
        .map((raw) => {
          try { return JSON.parse(raw) as SyncPacket; } catch { return null; }
        })
        .filter((p): p is SyncPacket => !!p && p.data_type === dataType && p.device_id !== excludeDeviceId),
    listVersions: async () => [],
    testConnection: async () => ({ ok: true, message: "" }),
  }),
}));

const { SyncEngine } = await import("@/lib/sync/sync-engine");

function settings(): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    device_label: "This browser",
    active_backend: "webdav",
    backends: [{
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    }],
  };
}

function tree(urls: string[]): SyncBookmark[] {
  return [{
    id: "0", parentId: null, title: "", dateAdded: 0,
    children: [
      {
        id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0,
        children: urls.map((url) => ({ id: `r-${url}`, parentId: "1", title: url, url, dateAdded: 1 })),
      },
      { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
      { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
    ],
  }];
}

/** A real, checksummed v1.0 peer packet, so openPacket() accepts it. */
async function putPeer(deviceId: string, urls: string[]): Promise<void> {
  const payload: BookmarkPayload = { tree: tree(urls), tombstones: [] };
  const raw = JSON.stringify(payload);
  const packet: SyncPacket = {
    version: "1.0",
    device_id: deviceId,
    device_label: "Other browser",
    timestamp: new Date().toISOString(),
    data_type: "bookmarks",
    checksum: await sha256(raw),
    encrypted: false,
    payload: raw,
  };
  h.blobs.set(`konode_bookmarks_${deviceId}.json`, JSON.stringify(packet));
}

async function seedLocal(): Promise<void> {
  await chrome.bookmarks.create({ parentId: "1", title: "Local", url: "https://local.example/" });
}

async function localUrls(): Promise<string[]> {
  const roots = await chrome.bookmarks.getTree();
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => {
    if (n.url) urls.push(n.url);
    n.children?.forEach(walk);
  };
  roots.forEach(walk);
  return urls.sort();
}

function engine() {
  return new SyncEngine(settings(), () => {});
}

beforeEach(() => {
  h.blobs.clear();
  h.uploads.length = 0;
  h.listFails = false;
  h.peerFailures.length = 0;
  h.deleteFails = false;
});

describe("first sync chooses a direction before anything is merged", () => {
  it("pauses when both sides have bookmarks, touching neither", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();

    expect(await e.sync()).toBe("first-sync-pending");
    expect(h.uploads).toEqual([]);
    expect(e.isSyncing).toBe(false);
    expect((await getState()).first_sync_pending?.peer_count).toBe(1);
    expect(await localUrls()).toEqual(["https://local.example/"]);
  });

  it("keeps waiting, without re-announcing or publishing, on every later cycle", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    expect(await e.sync()).toBe("first-sync-pending");
    const askedAt = (await getState()).first_sync_pending?.at;

    expect(await e.sync(undefined, { force: true })).toBe("first-sync-pending");
    expect((await getState()).first_sync_pending?.at).toBe(askedAt);
    expect(h.uploads).toEqual([]);
    expect(await localUrls()).toEqual(["https://local.example/"]);
  });

  it("merge keeps both sides and publishes the union", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    await e.chooseFirstSync("merge");

    expect(await localUrls()).toEqual(["https://local.example/", "https://peer.example/"]);
    expect((await getState()).first_sync_pending).toBeNull();
    expect((await getFirstSync())?.done).toBe(true);
    expect(h.uploads).toContain("me");
  });

  it("local removes the peers' bookmark files and publishes this tree", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    await e.chooseFirstSync("local");

    expect(h.blobs.has("konode_bookmarks_peer.json")).toBe(false);
    expect(h.blobs.has("konode_bookmarks_me.json")).toBe(true);
    expect(await localUrls()).toEqual(["https://local.example/"]);
  });

  it("remote replaces this tree with the newest peer's", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    await e.chooseFirstSync("remote");

    expect(await localUrls()).toEqual(["https://peer.example/"]);
    expect((await getState()).first_sync_pending).toBeNull();
  });

  it("never parks an ordinary sync when the storage refuses a listing (503)", async () => {
    h.listFails = true;
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);

    expect(await engine().sync()).toBe("ran");
    expect((await getState()).first_sync_pending ?? null).toBeNull();
  });

  it("does not ask a device that has already published bookmarks", async () => {
    await seedLocal();
    await setLastUploadChecksum("bookmarks", "already-published");
    await putPeer("peer", ["https://peer.example/"]);

    expect(await engine().sync()).toBe("ran");
    expect((await getState()).first_sync_pending ?? null).toBeNull();
  });

  it("the decision is per-install and never travels in a settings backup", async () => {
    await setFirstSync({ done: true, choice: "merge" });
    const backup = await exportSettingsBackup("1.5.9");
    expect(JSON.stringify(backup)).not.toContain("first_sync");
  });

  it("a storage that will not serve peer files is an ERROR, not a clean sync", async () => {
    await setFirstSync({ done: true }); // skip the direction question, test the backend failure
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    h.peerFailures.push("konode_bookmarks_peer.json (HTTP 503)");
    const e = engine();

    expect(await e.sync()).toBe("ran"); // degraded, not fatal
    const state = await getState();
    expect(state.status).toBe("error");
    expect(JSON.stringify(state.last_error ?? "")).toContain("NOT merged");
  });

  it("local refuses to report success when the storage refuses the deletions", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    h.deleteFails = true;
    const e = engine();
    await e.sync();

    await expect(e.chooseFirstSync("local")).rejects.toThrow(/could not be removed/);
    expect((await getFirstSync())?.done ?? false).toBe(false); // still open for a retry
    expect(h.blobs.has("konode_bookmarks_peer.json")).toBe(true);
  });
});
