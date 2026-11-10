import { describe, it, expect, beforeEach } from "vitest";
import {
  cachedPeerPacket,
  peerFileVersion,
  rememberPeerPackets,
} from "@/lib/utils/peer-packet-cache";
import { KEYS } from "@/lib/utils/storage";
import type { SyncPacket } from "@/lib/types";

const packet = (id: string): SyncPacket => ({
  version: "1.0",
  device_id: id,
  device_label: "Peer",
  timestamp: "2026-11-10T00:00:00.000Z",
  data_type: "bookmarks",
  payload: "{}",
}) as unknown as SyncPacket;

const SCOPE = "https://dav.example.com/kesonode#alice";
const OTHER = "https://dav.example.com/kesonode#bob";

describe("peer packet cache", () => {
  beforeEach(async () => {
    await chrome.storage.local.remove(KEYS.PEER_PACKET_CACHE);
  });

  it("serves a packet back for the same file version and storage", async () => {
    const p = packet("a");
    await rememberPeerPackets(SCOPE, [{ name: "konode_bookmarks_a.json", version: "m1s2", packet: p }]);
    expect(await cachedPeerPacket("konode_bookmarks_a.json", "m1s2", SCOPE)).toEqual(p);
  });

  it("never serves a packet from a DIFFERENT storage", async () => {
    // File names are konode_<type>_<device_id>.json, and the same device id can exist in
    // two accounts. Handing account A's bytes to account B would merge one user's data
    // into another's, silently — the scope is what makes that impossible.
    const p = packet("a");
    await rememberPeerPackets(SCOPE, [{ name: "konode_bookmarks_a.json", version: "m1s2", packet: p }]);
    expect(await cachedPeerPacket("konode_bookmarks_a.json", "m1s2", OTHER)).toBeNull();
  });

  it("re-fetches when the file changed", async () => {
    await rememberPeerPackets(SCOPE, [{ name: "f", version: "m1s2", packet: packet("a") }]);
    expect(await cachedPeerPacket("f", "m1s3", SCOPE)).toBeNull(); // same mtime, new size
    expect(await cachedPeerPacket("f", "m9s2", SCOPE)).toBeNull(); // new mtime
  });

  it("never caches or serves an entry with no version", async () => {
    // No modification time in the listing means nothing to compare, so the file must be
    // downloaded every time rather than guessed at.
    await rememberPeerPackets(SCOPE, [{ name: "f", version: "", packet: packet("a") }]);
    expect(await cachedPeerPacket("f", "", SCOPE)).toBeNull();
    expect(await cachedPeerPacket("f", "m1s2", SCOPE)).toBeNull();
  });

  it("refuses to work without a scope", async () => {
    await rememberPeerPackets("", [{ name: "f", version: "m1", packet: packet("a") }]);
    expect(await cachedPeerPacket("f", "m1", "")).toBeNull();
  });

  it("writes the whole cycle in one go and keeps the newest entries", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `f${i}`, version: "m1", packet: packet(`d${i}`),
    }));
    await rememberPeerPackets(SCOPE, many);
    const raw = (await chrome.storage.local.get(KEYS.PEER_PACKET_CACHE))[KEYS.PEER_PACKET_CACHE];
    expect(Object.keys(raw).length).toBeLessThanOrEqual(24);
    // The last entry of the batch is the newest, so it must have survived the trim.
    expect(await cachedPeerPacket("f39", "m1", SCOPE)).not.toBeNull();
  });

  it("survives a corrupt cache", async () => {
    await chrome.storage.local.set({ [KEYS.PEER_PACKET_CACHE]: "nonsense" });
    expect(await cachedPeerPacket("f", "m1", SCOPE)).toBeNull();
    await rememberPeerPackets(SCOPE, [{ name: "f", version: "m1", packet: packet("a") }]);
    expect(await cachedPeerPacket("f", "m1", SCOPE)).not.toBeNull();
  });
});

describe("peerFileVersion", () => {
  it("is empty without a modification time, so a backend that reports none never reuses bytes", () => {
    expect(peerFileVersion(null)).toBe("");
    expect(peerFileVersion(null, 100)).toBe("");
  });

  it("includes the size, because two files can share a second-resolution mtime", () => {
    expect(peerFileVersion(1000, 10)).not.toBe(peerFileVersion(1000, 11));
    expect(peerFileVersion(1000, 10)).toBe(peerFileVersion(1000, 10));
  });

  it("still works when the listing carries no size", () => {
    expect(peerFileVersion(1000)).toBe(peerFileVersion(1000));
    expect(peerFileVersion(1000)).not.toBe(peerFileVersion(1001));
  });
});
