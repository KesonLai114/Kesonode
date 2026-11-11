import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SETTINGS, getState } from "@/lib/utils/storage";
import { HttpError } from "@/lib/utils/retry";
import type { DataType, SyncPacket, SyncSettings } from "@/lib/types";

// What the popup and the onboarding finish screen print comes from sync() as a whole, not
// from syncType, and sync() builds its own backend from the active config. So the backend
// is mocked here, the way devices.test.ts does it, instead of in sync-engine.test.ts.

// What Nutstore's 403 says, shortened: the text is not the point, its shape is — one long
// explanation of the shared quota, attached to whichever type happened to be syncing.
const NUTSTORE_403 =
  "Forbidden (403): dav.example.com refused the request. Nutstore (坚果云) limits WebDAV by frequency — counted across EVERY app using this account.";

const h = vi.hoisted(() => ({
  packets: [] as SyncPacket[],
  blobs: new Map<string, string>(),
  // What the storage does on the first peer download of a cycle: throw a Nutstore 403
  // (the upload path then throws too), or swallow it the way downloadAll does for one
  // refused peer file. Either way it marks the window spent.
  refuse: null as null | "throw" | "swallow",
  rateLimited: false,
  downloadCalls: [] as string[],
  uploads: 0,
  failedPeers: [] as string[],
}));

vi.mock("@/lib/backends/abstract-backend", () => ({
  createBackend: () => ({
    type: "webdav",
    failedPeers: h.failedPeers,
    get rateLimited() { return h.rateLimited; },
    isConfigured: () => true,
    connect: async () => {},
    disconnect: async () => {},
    upload: async (p: SyncPacket) => {
      h.uploads++;
      h.blobs.set(`konode_${p.data_type}_${p.device_id}.json`, JSON.stringify(p));
    },
    downloadAll: async (dataType: DataType, exclude?: string) => {
      h.downloadCalls.push(dataType);
      if (h.refuse) {
        h.rateLimited = true;
        h.failedPeers.push(`konode_${dataType}_peer.json (HTTP 403)`);
        if (h.refuse === "throw") throw new HttpError(403, NUTSTORE_403, true);
        return [];
      }
      return h.packets.filter((p) => p.data_type === dataType && p.device_id !== exclude);
    },
    listFiles: async (prefix: string) => [...h.blobs.keys()].filter((n) => n.startsWith(prefix)),
    getFile: async (name: string) => h.blobs.get(name) ?? null,
    putFile: async (name: string, content: string) => { h.blobs.set(name, content); },
    deleteFile: async (name: string) => { h.blobs.delete(name); },
    listVersions: async () => [],
    testConnection: async () => ({ ok: true, message: "" }),
  }),
}));

const { SyncEngine } = await import("@/lib/sync/sync-engine");

function settings(): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "me",
    enabled_types: ["bookmarks", "history", "extensions", "sessions"],
    active_backend: "webdav",
    backends: [{
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
    }],
  };
}

/** An end-to-end encrypted peer's bookmarks. Only the `encrypted` flag matters here: a
 *  device with E2EE off refuses the packet before it would try to read the payload. */
function encryptedPeer(device_id: string): SyncPacket {
  return {
    version: "1.0", device_id, data_type: "bookmarks",
    timestamp: "2026-09-30T10:00:00.000Z", checksum: "a".repeat(64),
    encrypted: true, payload: "<ciphertext>",
  } as SyncPacket;
}

beforeEach(() => {
  h.packets.length = 0;
  h.blobs.clear();
  h.refuse = null;
  h.rateLimited = false;
  h.downloadCalls.length = 0;
  h.uploads = 0;
  h.failedPeers.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("SyncEngine.sync: Activity's counters", () => {
  it("counts cycles once per run and items per type, not runs per type", async () => {
    // The field report: Activity read "书签 683 / 扩展 682" and 1,365 "sync runs" after
    // ~683 cycles. Both numbers were sync_counts — one increment per completed type — so a
    // four-type cycle added four "runs" and the extension figure grew like an inventory.
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com" });
    const engine = new SyncEngine(settings(), () => {});

    await engine.sync();
    await engine.sync();

    const st = await getState();
    expect(st.sync_cycles).toBe(2);
    expect(st.sync_counts.bookmarks).toBe(2);
    expect(st.sync_totals?.bookmarks).toBe(2);
  });
});

describe("SyncEngine.sync: the problem line says each thing once", () => {
  it("prints the E2EE message once however many encrypted devices are in the folder", async () => {
    // From the 1.4.x device QA: a new device without E2EE, set up on a folder that two
    // encrypted devices use, finished onboarding with "Some of your devices are end-to-end
    // encrypted..." twice in a row. The warning is kept per peer, and the sentence names
    // no device, so the two copies read as one message repeated.
    h.packets.push(encryptedPeer("dc0b7b0f-peer"), encryptedPeer("3cff6456-peer"));

    expect(await new SyncEngine(settings(), () => {}).sync()).toBe("ran");

    const st = await getState();
    expect(st.status).toBe("error");
    const msg = "Some of your devices are end-to-end encrypted.";
    expect(st.last_error?.split(msg).length).toBe(2); // exactly one occurrence
  });

  it("stops walking data types once the storage is metering, and says it once", async () => {
    // The field report: "extensions: Forbidden (403) …" followed by "Couldn't read 1
    // device file(s)". Every remaining type would have been refused locally by the
    // backend's own guard, so the only thing continuing achieved was one copy of the
    // quota explanation per type, plus a file-level sentence for a storage-level fact.
    h.refuse = "throw";

    expect(await new SyncEngine(settings(), () => {}).sync()).toBe("ran");

    expect(h.downloadCalls).toEqual(["bookmarks"]); // nothing else was attempted
    expect(h.uploads).toBe(0);
    const st = await getState();
    expect(st.status).toBe("error");
    // One storage-level sentence, no type prefix, nothing merged.
    expect(st.last_error?.split("Nutstore (坚果云) limits WebDAV by frequency").length).toBe(2);
    expect(st.last_error).not.toMatch(/^bookmarks:/);
    expect(st.last_error).toContain("Nothing further was attempted this cycle");
    expect(st.last_error).not.toContain("Couldn't read");
    // The types that got no attempt are not "synced and current" — they did not run.
    expect(st.failed_types?.sort()).toEqual(["bookmarks", "extensions", "history", "sessions"]);
  });

  it("stops the same way when the refusal was swallowed by a peer download", async () => {
    // downloadAll skips a refused peer file by design (one bad file must not stop the
    // merge). That refusal is still the whole window, so the next type must not be tried
    // and the "couldn't read a device file" line must not turn it into a file problem.
    h.refuse = "swallow";

    expect(await new SyncEngine(settings(), () => {}).sync()).toBe("ran");

    expect(h.downloadCalls).toEqual(["bookmarks"]);
    const st = await getState();
    expect(st.status).toBe("error");
    expect(st.last_error?.split("Too many requests").length).toBe(2);
    expect(st.last_error).toContain("Nothing further was attempted this cycle");
    expect(st.last_error).not.toContain("Couldn't read");
    expect(st.failed_types?.sort()).toEqual(["bookmarks", "extensions", "history", "sessions"]);
  });
});
