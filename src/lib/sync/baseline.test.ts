import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS, getState, getFirstSync, setFirstSync, getLastUploadChecksum,
  setLastUploadChecksum, clearSyncCooldown, KEYS,
} from "@/lib/utils/storage";

import { sha256 } from "@/lib/crypto/encryption";
import { BASELINE_FILE, readBaselineMarker, writeBaselineMarker } from "@/lib/sync/baseline";
import type { BookmarkPayload, IBackend, SyncBookmark, SyncPacket, SyncSettings } from "@/lib/types";

// The engine builds its own backend from the active config, so createBackend is mocked the
// same way first-sync.test.ts does it.
const h = vi.hoisted(() => ({
  blobs: new Map<string, string>(),
  uploads: [] as string[],
  deleteFails: false,
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    isConfigured: () => true,
    failedPeers: [] as string[],
    rateLimited: false,
    connect: async () => {},
    disconnect: async () => {},
    listFiles: async (prefix: string) =>
      [...h.blobs.keys()].filter((n) => n.startsWith(prefix)),
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

function settings(overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    device_label: "This browser",
    active_backend: "webdav",
    backends: [{
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    }],
    ...overrides,
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

async function putPeer(deviceId: string, urls: string[], label = "Other browser"): Promise<string> {
  const payload: BookmarkPayload = { tree: tree(urls), tombstones: [] };
  const raw = JSON.stringify(payload);
  const packet: SyncPacket = {
    version: "1.0",
    device_id: deviceId,
    device_label: label,
    timestamp: new Date().toISOString(),
    data_type: "bookmarks",
    checksum: await sha256(raw),
    encrypted: false,
    payload: raw,
  };
  h.blobs.set(`konode_bookmarks_${deviceId}.json`, JSON.stringify(packet));
  return packet.checksum;
}

function putMarker(
  deviceId: string, label = "Other browser", at = "2026-11-11T00:00:00.000Z", checksum?: string,
): void {
  h.blobs.set(BASELINE_FILE, JSON.stringify({
    version: "1.0",
    encrypted: false,
    payload: JSON.stringify({
      version: 1, device_id: deviceId, device_label: label, at,
      ...(checksum ? { checksum } : {}),
    }),
  }));
}

function packetChecksum(raw: string): string {
  return (JSON.parse(raw) as SyncPacket).checksum;
}

function marker(): { device_id: string; at: string } | null {
  const raw = h.blobs.get(BASELINE_FILE);
  if (!raw) return null;
  const file = JSON.parse(raw) as { payload: string };
  return JSON.parse(file.payload) as { device_id: string; at: string };
}

async function seedLocal(url = "https://local.example/"): Promise<void> {
  await chrome.bookmarks.create({ parentId: "1", title: url, url });
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

const engine = (overrides: Partial<SyncSettings> = {}) => new SyncEngine(settings(overrides), () => {});

beforeEach(async () => {
  h.blobs.clear();
  h.uploads.length = 0;
  h.deleteFails = false;
  await clearSyncCooldown();
});

describe("the shared baseline marker", () => {
  it("reads an absent file as 'no baseline', not as an error", async () => {
    const files = new Map<string, string>();
    const backend = {
      getFile: async (name: string) => files.get(name) ?? null,
    } as unknown as IBackend;
    await expect(readBaselineMarker(backend, settings())).resolves.toEqual({ marker: null, unreadable: false });
  });

  it("round-trips an unencrypted marker", async () => {
    const files = new Map<string, string>();
    const backend = {
      getFile: async (name: string) => files.get(name) ?? null,
      putFile: async (name: string, content: string) => { files.set(name, content); },
    } as unknown as IBackend;
    await writeBaselineMarker(backend, settings(), {
      version: 1, device_id: "peer", device_label: "Peer", at: "2026-11-11T00:00:00.000Z",
    });
    const read = await readBaselineMarker(backend, settings());
    expect(read.marker).toMatchObject({ device_id: "peer", device_label: "Peer" });
    expect(read.unreadable).toBe(false);
  });

  it("encrypts the marker when E2EE is on and reads it back with the same passphrase", async () => {
    const files = new Map<string, string>();
    const backend = {
      getFile: async (name: string) => files.get(name) ?? null,
      putFile: async (name: string, content: string) => { files.set(name, content); },
    } as unknown as IBackend;
    const secure = settings({ encryption_enabled: true, encryption_passphrase: "long-passphrase" });
    await writeBaselineMarker(backend, secure, {
      version: 1, device_id: "peer", at: "2026-11-11T00:00:00.000Z",
    });
    expect(JSON.parse(files.get(BASELINE_FILE)!).encrypted).toBe(true);
    expect((await readBaselineMarker(backend, secure)).marker?.device_id).toBe("peer");

    // A device without the passphrase cannot name the baseline, and must not treat that as
    // "no baseline" — the cache is what keeps the last known answer visible.
    const plain = settings();
    await expect(readBaselineMarker(backend, plain)).resolves.toEqual({ marker: null, unreadable: true });
  });

  it("reports an invalid payload as unreadable rather than as no baseline", async () => {
    const backend = {
      getFile: async () => "not json",
    } as unknown as IBackend;
    await expect(readBaselineMarker(backend, settings())).resolves.toEqual({ marker: null, unreadable: true });
  });
});

describe("choosing this browser as the baseline", () => {
  it("removes the peers' files, writes the shared marker and records that this browser is aligned", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    await setLastUploadChecksum("bookmarks", "old-tag");

    const e = engine();
    const result = await e.setBaseline();

    expect(marker()).toMatchObject({ device_id: "me" });
    expect(result.marker.device_id).toBe("me");
    expect(result.adopted_at).toBe(result.marker.at);
    expect(h.blobs.has("konode_bookmarks_peer.json")).toBe(false);
    // This tree is published before the marker names it, so followers never adopt a
    // stale copy of this browser.
    expect(h.uploads).toContain("me");
    expect(JSON.parse(h.blobs.get("konode_baseline.json")!).payload).toContain(packetChecksum(h.blobs.get("konode_bookmarks_me.json")!));
    // Replacing peers' trees is destructive; the restore point comes first.
    expect([...h.blobs.keys()].some((n) => n.startsWith("konode_snap_"))).toBe(true);
    // The tree was published as part of naming it, so the next cycle has nothing to send.
    expect(await getLastUploadChecksum("bookmarks")).not.toBe("old-tag");
    expect(await getLastUploadChecksum("bookmarks")).not.toBeNull();
  });

  it("writes no marker when a peer file cannot be removed", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    h.deleteFails = true;

    await expect(engine().setBaseline()).rejects.toThrow(/could not be removed/);
    // A baseline that cannot replace the peers' trees would look enforced for one cycle
    // and be undone by their next upload.
    expect(marker()).toBeNull();
    expect(h.blobs.has("konode_bookmarks_peer.json")).toBe(true);
  });

  it("refuses to name an empty tree as the baseline", async () => {
    await putPeer("peer", ["https://peer.example/"]);

    await expect(engine().setBaseline()).rejects.toThrow(/no bookmarks to use as the baseline/);
    // Followers would otherwise replace their bookmarks with an empty file.
    expect(marker()).toBeNull();
    expect(h.blobs.has("konode_bookmarks_peer.json")).toBe(true);
  });

  it("answers the first-sync question in the same pass", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    expect(await engine().sync()).toBe("first-sync-pending");

    const e = engine();
    await e.setBaseline();

    expect((await getFirstSync())?.done).toBe(true);
    expect((await getState()).first_sync_pending ?? null).toBeNull();
    expect(await localUrls()).toEqual(["https://local.example/"]);
  });
});

describe("another browser's baseline is applied once", () => {
  it("replaces this tree, keeps a restore point and then merges both ways again", async () => {
    await seedLocal();
    const designated = await putPeer("peer", ["https://peer.example/"]);
    putMarker("peer", "Other browser", "2026-11-11T00:00:00.000Z", designated);

    const e = engine();
    expect(await e.sync()).toBe("ran");

    // The peer's tree became the starting point; the first-sync question was answered by
    // the marker instead of being asked here.
    expect(await localUrls()).toEqual(["https://peer.example/"]);
    expect((await getFirstSync())?.done).toBe(true);
    expect(h.uploads).toContain("me");
    expect((await getState()).first_sync_pending ?? null).toBeNull();
    expect((await chrome.storage.local.get(KEYS.BASELINE_ADOPTED))[KEYS.BASELINE_ADOPTED])
      .toMatchObject({ device_id: "peer", at: "2026-11-11T00:00:00.000Z" });
    expect([...h.blobs.keys()].some((n) => n.startsWith("konode_snap_manual_"))).toBe(true);

    // A bookmark added here after the alignment must survive the next cycle: the marker
    // has been adopted, so the merge runs instead of replacing the tree a second time.
    await seedLocal("https://after-align.example/");
    await putPeer("peer", ["https://peer.example/", "https://peer-new.example/"]);
    await e.sync();
    expect(await localUrls()).toEqual([
      "https://after-align.example/",
      "https://peer-new.example/",
      "https://peer.example/",
    ]);
  });

  it("does not adopt a previous upload when the marker names a newer tree", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    putMarker("peer", "Other browser", "2026-11-11T00:00:00.000Z", "0".repeat(64));

    const e = engine();
    // Nothing is merged either: this device has never answered the direction question,
    // and a blocked baseline adoption must not answer it by accident.
    expect(await e.sync()).toBe("first-sync-pending");

    // The file in the folder is the peer's old tree. Adopting it and marking the
    // generation done would leave this browser aligned with the wrong copy.
    expect(await localUrls()).toEqual(["https://local.example/"]);
    expect((await chrome.storage.local.get(KEYS.BASELINE_ADOPTED))[KEYS.BASELINE_ADOPTED])
      .toBeUndefined();

    const designated = await putPeer("peer", ["https://peer.example/", "https://new.example/"]);
    putMarker("peer", "Other browser", "2026-11-11T00:00:00.000Z", designated);
    await e.sync();
    expect(await localUrls()).toEqual(["https://new.example/", "https://peer.example/"]);
  });

  it("waits for the baseline device to publish, then applies it on a later cycle", async () => {
    await seedLocal();
    putMarker("peer"); // no peer packet yet

    const e = engine();
    expect(await e.sync()).toBe("ran");
    expect(await localUrls()).toEqual(["https://local.example/"]);
    expect((await chrome.storage.local.get(KEYS.BASELINE_ADOPTED))[KEYS.BASELINE_ADOPTED])
      .toBeUndefined();

    await putPeer("peer", ["https://peer.example/"]);
    await e.sync();
    expect(await localUrls()).toEqual(["https://peer.example/"]);
  });

  it("does not mark another device's marker as adopted when its packet cannot be opened", async () => {
    await seedLocal();
    putMarker("peer");
    const payload = JSON.stringify({ tree: tree(["https://peer.example/"]), tombstones: [] });
    h.blobs.set("konode_bookmarks_peer.json", JSON.stringify({
      version: "1.0",
      device_id: "peer",
      device_label: "Other browser",
      timestamp: new Date().toISOString(),
      data_type: "bookmarks",
      checksum: "0".repeat(64), // does not match the payload
      encrypted: false,
      payload,
    }));

    await engine().sync();

    expect(await localUrls()).toEqual(["https://local.example/"]);
    expect((await chrome.storage.local.get(KEYS.BASELINE_ADOPTED))[KEYS.BASELINE_ADOPTED])
      .toBeUndefined();
  });

  it("clears the marker when the baseline device is forgotten", async () => {
    putMarker("peer");
    // A new browser would otherwise wait for this device to publish forever.
    await engine().forgetDevice("peer");
    expect(marker()).toBeNull();
  });

  it("clears the marker and lets both sides merge again", async () => {
    await seedLocal();
    await putPeer("peer", ["https://peer.example/"]);
    putMarker("peer");
    await setFirstSync({ done: true, choice: "merge" });

    const e = engine();
    await e.clearBaseline();

    expect(marker()).toBeNull();
    expect(await e.getBaselineInfo()).toMatchObject({ marker: null, adopted_at: null, cached: false });
    await e.sync();
    expect(await localUrls()).toEqual(["https://local.example/", "https://peer.example/"]);
  });
});
