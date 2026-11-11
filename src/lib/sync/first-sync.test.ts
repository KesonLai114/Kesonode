import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS, getState, getFirstSync, setFirstSync,
  setLastUploadChecksum, getLastUploadChecksum, setTombstones, exportSettingsBackup,
  syncCooldownRemaining, clearSyncCooldown,
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
  // Set to make downloadAll answer [] while failedPeers already names the reason, which
  // is exactly what a backend does when a peer file exists and cannot be read.
  downloadFails: false,
  // Stands in for the storage refusing this cycle's requests (Nutstore's 403).
  rateLimited: false,
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    isConfigured: () => true,
    failedPeers: h.peerFailures,
    get rateLimited() { return h.rateLimited; },
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
      h.downloadFails
        ? []
        : [...h.blobs.values()]
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

beforeEach(async () => {
  h.blobs.clear();
  h.uploads.length = 0;
  h.listFails = false;
  h.peerFailures.length = 0;
  h.deleteFails = false;
  h.downloadFails = false;
  h.rateLimited = false;
  await clearSyncCooldown();
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
    expect((await getState()).status).toBe("idle");
    expect(e.isSyncing).toBe(false);
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

  it("honours an explicit merge without permanently changing manual conflict mode", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = new SyncEngine({ ...settings(), conflict_strategy: "manual" }, () => {});
    await e.sync();
    await e.chooseFirstSync("merge");
    expect(await localUrls()).toEqual(["https://local.example/", "https://peer.example/"]);
    expect((await getState()).pending_conflicts).toEqual([]);
    const published = JSON.parse(h.blobs.get("konode_bookmarks_me.json")!) as SyncPacket;
    expect(published.payload).toContain("https://peer.example/");
    await putPeer("peer", ["https://new.example/"]);
    await e.sync();
    expect((await getState()).pending_conflicts).toHaveLength(1);
    expect(await localUrls()).not.toContain("https://new.example/");
  });

  it("does not ask an upgraded device again after changing its encryption settings", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    await setLastUploadChecksum("bookmarks", "already-published");
    const e = engine();
    await e.updateSettings({ ...settings(), encryption_enabled: true, encryption_passphrase: "long-passphrase" });
    expect((await getFirstSync())?.done).toBe(true);
    expect(await e.sync()).toBe("ran");
    expect((await getState()).first_sync_pending ?? null).toBeNull();
    expect(JSON.parse(h.blobs.get("konode_bookmarks_me.json")!).encrypted).toBe(true);
  });

  it("records successful publishing independently of the upload checksum", async () => {
    await seedLocal();
    await engine().sync();
    expect((await getFirstSync())?.done).toBe(true);
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

  it("local does not make the other data types upload again", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();
    await setLastUploadChecksum("history", "history-tag");
    await setLastUploadChecksum("extensions", "extensions-tag");

    await e.chooseFirstSync("local");

    expect(await getLastUploadChecksum("history")).toBe("history-tag");
    expect(await getLastUploadChecksum("extensions")).toBe("extensions-tag");
  });

  it("ignores a second answer once the question is settled", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();
    await e.chooseFirstSync("local");
    // The answer already settled the question; a tab left open must not run it again,
    // even though the peer has re-uploaded in the meantime.
    await putPeer("peer", ["https://peer.example/"]);

    await e.chooseFirstSync("local");

    expect(h.blobs.has("konode_bookmarks_peer.json")).toBe(true);
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

  it("does not ask when this browser has no bookmarks, even with a deletion log to publish", async () => {
    // The deletion log makes the payload non-empty, but there is no tree to protect.
    await setTombstones([{ url: "https://gone.example/", deletedAt: Date.now(), own: true }]);
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

  it("remote repeats the storage's own reason when the peer file cannot be read", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    // The file is there and listed; fetching it is what fails. "try again once it is
    // reachable" is useless advice for a 403/oversize/corrupt file, and the reason was
    // already recorded — it just never reached the user.
    h.downloadFails = true;
    h.peerFailures.push("konode_bookmarks_peer.json (HTTP 403)");

    await expect(e.chooseFirstSync("remote")).rejects.toThrow(/HTTP 403/);
    expect((await getFirstSync())?.done ?? false).toBe(false); // the question stays open
    expect(await localUrls()).toEqual(["https://local.example/"]); // untouched
  });

  it("remote says the folder holds no peer file when it has been emptied by hand", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    h.blobs.delete("konode_bookmarks_peer.json"); // tidied away in the storage

    await expect(e.chooseFirstSync("remote")).rejects.toThrow(/no longer holds another device's bookmark file/);
    expect((await getFirstSync())?.done ?? false).toBe(false);
    expect(await localUrls()).toEqual(["https://local.example/"]);
  });

  it("remote leaves no restore point behind when the download is refused", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    h.downloadFails = true;
    h.peerFailures.push("konode_bookmarks_peer.json (HTTP 403)");

    await expect(e.chooseFirstSync("remote")).rejects.toThrow(/HTTP 403/);
    // A restore point for a replacement that never happened is clutter the user has to
    // tidy up, and it costs a PUT inside the very window that refused the read. A field
    // report had two identical ones from two clicks, neither of which changed anything.
    expect([...h.blobs.keys()].filter((n) => n.includes("konode_snap_manual_"))).toEqual([]);
  });

  it("remote does not claim a replacement when the chosen peer holds no bookmarks", async () => {
    await seedLocal();
    // A peer file that opens cleanly but carries an empty tree: the import refuses to
    // wipe this device for it, which is right. Reporting "Replaced this device's
    // bookmarks" anyway was not — nothing had changed, and the question was marked
    // answered.
    await putPeer("peer", []);
    const e = engine();
    await e.sync();

    await expect(e.chooseFirstSync("remote")).rejects.toThrow(/holds no bookmarks/);
    expect(await localUrls()).toEqual(["https://local.example/"]);
    expect((await getFirstSync())?.done ?? false).toBe(false);
    expect((await getState()).first_sync_pending?.peer_count).toBe(1);
    // Nothing was replaced, so no restore point was needed for it either.
    expect([...h.blobs.keys()].filter((n) => n.includes("konode_snap_manual_"))).toEqual([]);
  });

  it("remote parks automatic sync when the storage is metering, not merely failing", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    const e = engine();
    await e.sync();

    h.downloadFails = true;
    h.rateLimited = true;
    h.peerFailures.push("konode_bookmarks_peer.json (HTTP 403)");

    // The message invites the user to choose again; without the cooldown that retry lands
    // in a window with nothing left in it and is refused identically.
    await expect(e.chooseFirstSync("remote")).rejects.toThrow(/rate limit/i);
    expect(await syncCooldownRemaining()).toBeGreaterThan(0);
  });
});