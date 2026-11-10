import { describe, it, expect, afterEach, vi } from "vitest";
import { GDriveBackend } from "./gdrive-backend";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig, SyncPacket } from "@/lib/types";
import { resetCompatMode, setCompatMode } from "@/lib/compat/protocol";
import { HttpError } from "@/lib/utils/retry";

// Drive keys files by id, not by name, so one folder can legitimately hold two files
// called konode_<type>_<device>.json: an upload that created where it should have patched,
// or two writes racing. Both came back as peers, and the stale one, folded in
// last, was the one that won. Its `name contains` filter is a loose token match as well,
// so the query can answer with names that merely share the words.

const cfg: BackendConfig = {
  type: "gdrive", label: "Google Drive", enabled: true, gdrive: { folderId: "pinned" },
};

function packet(deviceId: string, timestamp: string): SyncPacket {
  return {
    version: "1.0", device_id: deviceId, timestamp, data_type: "extensions",
    checksum: "a".repeat(64), encrypted: false, payload: "[]",
  };
}

/** Drive lists via a files?q= URL (no ".json"), then fetches files/<id>?alt=media. */
function driveHolds(
  files: Array<{ id: string; name: string }>,
  bodies: Record<string, SyncPacket>
): () => number {
  let downloads = 0;
  vi.stubGlobal("fetch", (url: string) => {
    const s = String(url);
    if (s.includes("alt=media")) {
      downloads++;
      const id = /files\/([^?]+)\?/.exec(s)?.[1] ?? "";
      const body = bodies[id];
      return Promise.resolve({
        ok: !!body, status: body ? 200 : 404,
        text: () => Promise.resolve(JSON.stringify(body ?? {})),
      } as Response);
    }
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({ files }),
    } as Response);
  });
  return () => downloads;
}

async function signedIn(): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.GDRIVE_SESSION]: {
      access_token: "t", expires_at: Date.now() + 3_600_000,
      email: "", displayName: "", savedAt: Date.now(),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetCompatMode();
});

describe("Drive downloadAll: one file per device, and only files that are ours to read", () => {
  it("takes the newest of two files for the same device, and downloads only that one", async () => {
    await signedIn();
    // The listing is ordered modifiedTime desc, so the current file comes first.
    const downloads = driveHolds(
      [
        { id: "new", name: "konode_extensions_peer1.json" },
        { id: "old", name: "konode_extensions_peer1.json" },
      ],
      {
        new: packet("peer1", "2026-08-24T10:00:00.000Z"),
        old: packet("peer1", "2026-08-01T10:00:00.000Z"),
      }
    );

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.timestamp)).toEqual(["2026-08-24T10:00:00.000Z"]);
    expect(downloads()).toBe(1); // the stale copy isn't even fetched
  });

  it("ignores a name the loose `contains` query matched but we never wrote", async () => {
    await signedIn();
    const downloads = driveHolds(
      [
        { id: "snap", name: "konode_snap_extensions_1756200000000.json" },
        { id: "peer", name: "konode_extensions_peer1.json" },
      ],
      { snap: packet("peer1", "2026-08-26T10:00:00.000Z"), peer: packet("peer1", "2026-08-24T10:00:00.000Z") }
    );

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.timestamp)).toEqual(["2026-08-24T10:00:00.000Z"]);
    expect(downloads()).toBe(1);
  });

  it("still leaves our own file out", async () => {
    await signedIn();
    const downloads = driveHolds(
      [
        { id: "mine", name: "konode_extensions_me.json" },
        { id: "peer", name: "konode_extensions_peer1.json" },
      ],
      { mine: packet("me", "2026-08-26T10:00:00.000Z"), peer: packet("peer1", "2026-08-24T10:00:00.000Z") }
    );

    const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

    expect(packets.map((p) => p.device_id)).toEqual(["peer1"]);
    expect(downloads()).toBe(1);
  });
});

const pageToken = "next+/= &?#%页";
const snapshotPrefix = "konode_snap_bookmarks_";
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Drive paginated peer and snapshot listings", () => {
  it.each(["upstream", "isolated", "standalone"] as const)(
    "reads both peer pages in %s mode without stale duplicates or loose prefix matches",
    async (mode) => {
      await signedIn();
      setCompatMode(mode);
      const prefix = mode === "upstream" ? "konode_" : "kesonode_";
      const otherPrefix = mode === "upstream" ? "kesonode_" : "konode_";
      const first = [
        { id: "new", name: `${prefix}extensions_peer1.json` },
        { id: "mine", name: `${prefix}extensions_me.json` },
      ];
      const second = [
        { id: "old", name: `${prefix}extensions_peer1.json` },
        { id: "peer2", name: `${prefix}extensions_peer2.json` },
        { id: "other", name: `${otherPrefix}extensions_peer3.json` },
        { id: "other-copy", name: `${otherPrefix}extensions_peer1.json` },
        { id: "loose", name: `copy_${prefix}extensions_peer4.json` },
        { id: "snapshot", name: "konode_snap_extensions_1756200000000.json" },
        { id: "mine-again", name: `${prefix}extensions_me.json` },
      ];
      const bodies: Record<string, SyncPacket> = {
        new: packet("peer1", "2026-08-26T10:00:00.000Z"),
        peer2: packet("peer2", "2026-08-24T10:00:00.000Z"),
        other: packet("peer3", "2026-08-23T10:00:00.000Z"),
      };
      const listURLs: URL[] = [];
      const downloads: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t");
        if (u.searchParams.has("q")) {
          expect(u.searchParams.get("fields")).toBe("nextPageToken,files(id,name,modifiedTime)");
          expect(u.searchParams.get("orderBy")).toBe("modifiedTime desc");
          listURLs.push(u);
          if (!u.searchParams.has("pageToken")) return jsonResponse({ files: first, nextPageToken: pageToken });
          expect(u.searchParams.get("pageToken")).toBe(pageToken);
          expect(url).toContain(`pageToken=${encodeURIComponent(pageToken)}`);
          return jsonResponse({ files: second });
        }
        expect(listURLs).toHaveLength(2); // no partial-list downloads before page two succeeds
        expect(u.searchParams.get("alt")).toBe("media");
        const id = u.pathname.split("/").pop()!;
        downloads.push(id);
        expect(bodies[id]).toBeDefined();
        return jsonResponse(bodies[id]);
      }));

      const packets = await new GDriveBackend(cfg).downloadAll("extensions", "me");

      expect(packets).toEqual(mode === "isolated"
        ? [bodies.new, bodies.peer2, bodies.other]
        : [bodies.new, bodies.peer2]);
      expect(downloads).toEqual(mode === "isolated" ? ["new", "peer2", "other"] : ["new", "peer2"]);
      expect(listURLs.map(u => u.searchParams.get("q"))).toEqual([
        `${mode === "isolated" ? "name contains 'extensions_'" : `name contains '${prefix}extensions_'`} and 'pinned' in parents and trashed=false`,
        listURLs[0].searchParams.get("q"),
      ]);
    },
  );

  it.each(["listFiles", "listFilesWithTimes"] as const)(
    "%s includes snapshots on page two and keeps prefix/time handling",
    async (method) => {
      await signedIn();
      const firstName = `${snapshotPrefix}1.json`;
      const secondName = `${snapshotPrefix}2.json`;
      const thirdName = `${snapshotPrefix}3.json`;
      const fourthName = `${snapshotPrefix}4.json`;
      const time = "2026-08-24T10:00:00.000Z";
      const urls: URL[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        urls.push(u);
        expect(init?.cache).toBe("no-store");
        expect(u.searchParams.get("fields")).toBe(method === "listFiles"
          ? "nextPageToken,files(name)" : "nextPageToken,files(name,modifiedTime)");
        expect(u.searchParams.has("orderBy")).toBe(false);
        if (!u.searchParams.has("pageToken")) return jsonResponse({
          files: [{ name: firstName, modifiedTime: time }, { name: `copy_${firstName}` }],
          nextPageToken: pageToken,
        });
        expect(u.searchParams.get("pageToken")).toBe(pageToken);
        expect(url).toContain(`pageToken=${encodeURIComponent(pageToken)}`);
        return jsonResponse({ files: [
          { name: secondName, modifiedTime: time },
          { name: thirdName, modifiedTime: "invalid" },
          { name: fourthName },
          { name: `copy_${secondName}`, modifiedTime: time },
        ] });
      }));

      const result = await new GDriveBackend(cfg)[method](snapshotPrefix);

      expect(result).toEqual(method === "listFiles"
        ? [firstName, secondName, thirdName, fourthName]
        : [
          { name: firstName, modified: Date.parse(time) },
          { name: secondName, modified: Date.parse(time) },
          { name: thirdName, modified: null },
          { name: fourthName, modified: null },
        ]);
      expect(urls).toHaveLength(2);
      expect(urls[1].searchParams.get("q")).toBe(urls[0].searchParams.get("q"));
    },
  );

  it("continues through empty pages while nextPageToken is present", async () => {
    await signedIn();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ files: [], nextPageToken: "second" }))
      .mockResolvedValueOnce(jsonResponse({ nextPageToken: "third" }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ name: `${snapshotPrefix}1.json` }] }));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await new GDriveBackend(cfg).listFiles(snapshotPrefix)).toEqual([`${snapshotPrefix}1.json`]);
    expect(fetchSpy.mock.calls.map(([url]) => new URL(url).searchParams.get("pageToken")))
      .toEqual([null, "second", "third"]);
  });
});

describe("Drive failed later pages are not successful partial listings", () => {
  const operations: Array<{
    name: string;
    run: (be: GDriveBackend) => Promise<unknown>;
    context: string;
  }> = [
    { name: "peers", run: be => be.downloadAll("extensions"), context: "Drive list failed" },
    { name: "snapshot names", run: be => be.listFiles(snapshotPrefix), context: "Drive list failed" },
    { name: "snapshot times", run: be => be.listFilesWithTimes(snapshotPrefix), context: "Drive list failed" },
    { name: "file lookup", run: be => be.getFile("konode_snap_index.json"), context: "Drive lookup failed" },
    { name: "folder lookup", run: be => be.connect(), context: "Drive folder lookup failed" },
  ];

  for (const operation of operations) {
    it.each([
      { status: 403, reason: "rateLimitExceeded", limited: true, attempts: 1 },
      { status: 403, reason: "insufficientFilePermissions", limited: false, attempts: 1 },
      { status: 500, reason: "backendError", limited: false, attempts: 3 },
    ])(`${operation.name}: preserves HTTP $status ($reason) on page two`, async ({ status, reason, limited, attempts }) => {
      await signedIn();
      vi.useFakeTimers();
      const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        expect(init?.method ?? "GET").toBe("GET"); // never create/update from a partial lookup
        expect(u.searchParams.has("q")).toBe(true); // never download from a partial list
        return u.searchParams.has("pageToken")
          ? jsonResponse({ error: { errors: [{ reason }] } }, status)
          : jsonResponse({
            files: [{ id: "first", name: "konode_extensions_peer1.json" }],
            nextPageToken: pageToken,
          });
      });
      vi.stubGlobal("fetch", fetchSpy);
      const be = new GDriveBackend(operation.name === "folder lookup" ? { ...cfg, gdrive: {} } : cfg);
      const result = operation.run(be).catch((err: unknown) => err);
      await vi.runAllTimersAsync();
      const err = await result;

      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status, rateLimited: limited });
      expect((err as Error).message).toContain(`${operation.context}: ${status}`);
      expect(be.rateLimited).toBe(limited);
      expect(fetchSpy).toHaveBeenCalledTimes(2 * attempts);
    });
  }

  it("restarts a transiently failed listing without duplicating the successful first page", async () => {
    await signedIn();
    vi.useFakeTimers();
    let laterPageCalls = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      if (!new URL(url).searchParams.has("pageToken")) return jsonResponse({
        files: [{ name: `${snapshotPrefix}1.json` }], nextPageToken: pageToken,
      });
      return ++laterPageCalls === 1
        ? jsonResponse({}, 503)
        : jsonResponse({ files: [{ name: `${snapshotPrefix}2.json` }] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const result = expect(new GDriveBackend(cfg).listFiles(snapshotPrefix))
      .resolves.toEqual([`${snapshotPrefix}1.json`, `${snapshotPrefix}2.json`]);
    await vi.runAllTimersAsync();
    await result;
    expect(fetchSpy.mock.calls.map(([url]) => new URL(url).searchParams.get("pageToken")))
      .toEqual([null, pageToken, null, pageToken]);
  });
});
