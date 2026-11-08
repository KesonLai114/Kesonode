import { describe, it, expect, afterEach, vi } from "vitest";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { WebDAVBackend } from "@/lib/backends/webdav-backend";
import { sha256 } from "@/lib/crypto/encryption";
import { DEFAULT_SETTINGS } from "@/lib/utils/storage";
import type { BackendConfig, DataType, SyncPacket, SyncSettings } from "@/lib/types";
import {
  UPSTREAM_PROTOCOL,
  isPeerFileName,
  packetFileName,
  peerDeviceIdFromName,
  resetCompatMode,
  setCompatMode,
} from "./protocol";

// Golden tests against the upstream Konode v1.5.1 packet shape. Neither direction
// imports the upstream snapshot: the samples/rules below are written out as literals so
// they can never silently follow a change in our own implementation.
afterEach(() => {
  resetCompatMode();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type EnginePrivate = {
  buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket>;
  openPacket(packet: SyncPacket): Promise<unknown>;
};
const priv = (engine: SyncEngine): EnginePrivate => engine as unknown as EnginePrivate;

function makeEngine(mode?: "upstream" | "isolated"): SyncEngine {
  const settings: SyncSettings = {
    ...DEFAULT_SETTINGS,
    device_id: "kesonode-device",
    conflict_strategy: "lww",
    encryption_enabled: false,
    ...(mode ? { compat_mode: mode } : {}),
  };
  return new SyncEngine(settings, () => {});
}

const UPSTREAM_PAYLOAD = {
  tree: [{ id: "0", parentId: null, title: "", dateAdded: 0, children: [] }],
  tombstones: [],
};

/** Exactly what upstream writes: version 1.0, plaintext, SHA-256 over the payload. */
async function upstreamPacket(payload: unknown, deviceId = "upstream-device"): Promise<SyncPacket> {
  const raw = JSON.stringify(payload);
  return {
    version: "1.0",
    device_id: deviceId,
    device_label: "Upstream peer",
    timestamp: "2026-01-01T00:00:00.000Z",
    data_type: "bookmarks",
    checksum: await sha256(raw),
    encrypted: false,
    payload: raw,
  } as SyncPacket;
}

/** A reader implementing ONLY the upstream v1.0 rules, for the reverse direction. */
async function readAsUpstreamV1(packet: SyncPacket): Promise<unknown> {
  if (packet.version !== "1.0") throw new Error("not a v1.0 packet");
  if (packet.encrypted) throw new Error("this upstream reader handles plaintext only");
  if (packet.checksum?.length !== 64 || (await sha256(packet.payload)) !== packet.checksum) {
    throw new Error("checksum invalid or missing");
  }
  return JSON.parse(packet.payload);
}

describe("Kesonode <-> upstream Konode packet interop", () => {
  it("reads a packet written by an upstream Konode device", async () => {
    const packet = await upstreamPacket(UPSTREAM_PAYLOAD);
    await expect(priv(makeEngine()).openPacket(packet)).resolves.toEqual(UPSTREAM_PAYLOAD);
  });

  it("writes a packet an upstream v1.0 reader accepts, under the upstream file name", async () => {
    const packet = await priv(makeEngine()).buildPacket("bookmarks", UPSTREAM_PAYLOAD);
    expect(packet.version).toBe(UPSTREAM_PROTOCOL.packetVersion);
    expect(packet.encrypted).toBe(false);
    expect(await readAsUpstreamV1(packet)).toEqual(UPSTREAM_PAYLOAD);

    const name = packetFileName(packet.data_type, packet.device_id);
    expect(name).toBe(`konode_bookmarks_${packet.device_id}.json`);
    expect(peerDeviceIdFromName(name, "bookmarks")).toBe(packet.device_id);
  });

  it("refuses a future packet version even when its checksum is valid", async () => {
    const packet = await upstreamPacket(UPSTREAM_PAYLOAD);
    const future = { ...packet, version: "9.9" } as unknown as SyncPacket;
    await expect(priv(makeEngine()).openPacket(future)).rejects.toThrow(/Unsupported sync packet version/);
  });

  it("isolated mode writes kesonode_* but publishes an otherwise identical v1.0 packet", async () => {
    const packet = await priv(makeEngine("isolated")).buildPacket("bookmarks", UPSTREAM_PAYLOAD);
    expect(packetFileName(packet.data_type, packet.device_id))
      .toBe(`kesonode_bookmarks_${packet.device_id}.json`);
    expect(await readAsUpstreamV1(packet)).toEqual(UPSTREAM_PAYLOAD);
    // Its listing logic still recognises a peer that only ever wrote upstream files.
    expect(isPeerFileName("konode_bookmarks_upstream-device.json", "bookmarks")).toBe(true);
  });
});

const DAV_CONFIG: BackendConfig = {
  type: "webdav", label: "WebDAV", enabled: true,
  webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
};

const UPSTREAM_FILE = "konode_bookmarks_peer-upstream.json";
const ISOLATED_FILE = "kesonode_bookmarks_peer-kesonode.json";

/** A file as it sits on a WebDAV folder. downloadAll() only JSON.parses it, so the
 *  checksum need not be real here — openPacket() is covered by the golden tests above. */
function davPacket(deviceId: string): string {
  return JSON.stringify({
    version: "1.0",
    device_id: deviceId,
    device_label: deviceId,
    timestamp: "2026-01-01T00:00:00.000Z",
    data_type: "bookmarks",
    checksum: "0".repeat(64),
    encrypted: false,
    payload: JSON.stringify(UPSTREAM_PAYLOAD),
  });
}

function stubDav(files: { name: string; json: string }[]): void {
  const bodies = new Map(files.map((f) => [f.name, f.json]));
  const hrefs = files
    .map((f) => `<d:response><d:href>/dav/konode/${f.name}</d:href></d:response>`)
    .join("\n");
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${hrefs}
    <d:response><d:href>/dav/konode/konode_snap_bookmarks_1700000000000.json</d:href></d:response>
  </d:multistatus>`;

  vi.stubGlobal("fetch", (url: string | URL, init?: { method?: string }) => {
    if (init?.method === "PROPFIND") {
      return Promise.resolve({
        ok: true, status: 207, text: () => Promise.resolve(xml),
      } as Response);
    }
    const name = String(url).split("/").pop() ?? "";
    const body = bodies.get(name);
    return Promise.resolve({
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      text: () => Promise.resolve(body ?? ""),
    } as Response);
  });
}

describe("WebDAV double-read, single-write", () => {
  it("default upstream mode ignores kesonode_* files, exactly as the original did", async () => {
    stubDav([
      { name: UPSTREAM_FILE, json: davPacket("peer-upstream") },
      { name: ISOLATED_FILE, json: davPacket("peer-kesonode") },
    ]);
    const packets = await new WebDAVBackend(DAV_CONFIG).downloadAll("bookmarks", "me");
    expect(packets.map((p) => p.device_id)).toEqual(["peer-upstream"]);
  });

  it("isolated mode folds peers from BOTH namespaces", async () => {
    setCompatMode("isolated");
    stubDav([
      { name: UPSTREAM_FILE, json: davPacket("peer-upstream") },
      { name: ISOLATED_FILE, json: davPacket("peer-kesonode") },
    ]);
    const packets = await new WebDAVBackend(DAV_CONFIG).downloadAll("bookmarks", "me");
    expect(packets.map((p) => p.device_id).sort()).toEqual(["peer-kesonode", "peer-upstream"]);
  });

  it("excludes its own OLD upstream file after switching namespace", async () => {
    setCompatMode("isolated");
    stubDav([
      { name: "konode_bookmarks_me.json", json: davPacket("me") },
      { name: ISOLATED_FILE, json: davPacket("peer-kesonode") },
    ]);
    const packets = await new WebDAVBackend(DAV_CONFIG).downloadAll("bookmarks", "me");
    expect(packets.map((p) => p.device_id)).toEqual(["peer-kesonode"]);
  });
});
