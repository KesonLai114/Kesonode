import { describe, it, expect, afterEach } from "vitest";
import {
  UPSTREAM_PROTOCOL,
  ISOLATED_FILE_PREFIX,
  SUPPORTED_PACKET_VERSIONS,
  CURRENT_PACKET_VERSION,
  getCompatMode,
  setCompatMode,
  resetCompatMode,
  writePrefix,
  readPrefixes,
  listPrefixes,
  packetFileName,
  peerDeviceIdFromName,
  isPeerFileName,
  deviceFilePattern,
  snapshotFileName,
  snapshotTimestamp,
  assertSupportedPacketVersion,
} from "./protocol";

// The mode is process-wide (one extension runtime, one settings object). No test may
// leave the next one in the isolated namespace.
afterEach(() => resetCompatMode());

describe("the frozen upstream wire contract", () => {
  it("records the exact values a Konode v1.5.1 device puts on the wire", () => {
    // These are DATA, not product copy. Changing any one of them silently splits the
    // sync group with every upstream device — the constants are deliberately duplicated
    // here as literals so a refactor of protocol.ts cannot pass unnoticed.
    expect(UPSTREAM_PROTOCOL.packetVersion).toBe("1.0");
    expect(UPSTREAM_PROTOCOL.packetFilePrefix).toBe("konode_");
    expect(UPSTREAM_PROTOCOL.snapshotFilePrefix).toBe("konode_snap_bookmarks_");
    expect(UPSTREAM_PROTOCOL.snapshotIndexName).toBe("konode_snap_index.json");
    expect(UPSTREAM_PROTOCOL.driveFolderName).toBe("Konode");
    expect(UPSTREAM_PROTOCOL.defaultBackendPath).toBe("konode");
    expect(UPSTREAM_PROTOCOL.legacyVerifier).toBe("konode-verify-v1");
    expect(UPSTREAM_PROTOCOL.storageKeyPrefix).toBe("konode_");
    expect(UPSTREAM_PROTOCOL.alarms).toEqual({
      sync: "konode-sync",
      bookmarkSync: "konode-bookmark-sync",
    });
    expect(UPSTREAM_PROTOCOL.crypto).toMatchObject({
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: 600_000,
      saltBytes: 16,
      ivBytes: 12,
      checksum: "SHA-256",
    });
  });

  it("defaults to the upstream mode, so a settings blob from an older build changes nothing", () => {
    expect(getCompatMode()).toBe("upstream");
    setCompatMode(undefined);
    expect(getCompatMode()).toBe("upstream");
    expect(writePrefix()).toBe("konode_");
    expect(readPrefixes()).toEqual(["konode_"]);
    expect(SUPPORTED_PACKET_VERSIONS).toEqual(["1.0"]);
    expect(CURRENT_PACKET_VERSION).toBe("1.0");
  });
});

describe("upstream mode (default): one namespace, exactly like the original", () => {
  it("writes and recognises konode_<type>_<device>.json", () => {
    expect(packetFileName("bookmarks", "dev-1")).toBe("konode_bookmarks_dev-1.json");
    expect(packetFileName("sessions", "dev-2")).toBe("konode_sessions_dev-2.json");
    expect(peerDeviceIdFromName("konode_history_dev-2.json", "history")).toBe("dev-2");
    expect(isPeerFileName("konode_extensions_dev-3.json", "extensions")).toBe(true);
    expect(listPrefixes("bookmarks")).toEqual(["konode_bookmarks_"]);
    expect(listPrefixes()).toEqual(["konode_"]);
  });

  it("ignores restore points, other data types and foreign namespaces", () => {
    expect(isPeerFileName("konode_snap_bookmarks_1700000000000.json", "bookmarks")).toBe(false);
    expect(isPeerFileName("konode_snap_index.json", "bookmarks")).toBe(false);
    expect(isPeerFileName("konode_bookmarks_dev-1.json", "history")).toBe(false);
    expect(isPeerFileName("kesonode_bookmarks_dev-1.json", "bookmarks")).toBe(false);
    expect(peerDeviceIdFromName("konode_bookmarks_.json", "bookmarks")).toBeNull();
  });

  it("deviceFilePattern matches per-device files only", () => {
    const re = deviceFilePattern();
    expect(re.exec("konode_bookmarks_dev-1.json")?.[2]).toBe("dev-1");
    expect(re.test("konode_snap_bookmarks_1.json")).toBe(false);
    expect(re.test("kesonode_bookmarks_dev-1.json")).toBe(false);
  });
});

describe("isolated mode: double-read, single-write", () => {
  it("writes only kesonode_* but still sees upstream peers", () => {
    setCompatMode("isolated");
    expect(getCompatMode()).toBe("isolated");
    expect(writePrefix()).toBe(ISOLATED_FILE_PREFIX);
    expect(packetFileName("bookmarks", "dev-1")).toBe("kesonode_bookmarks_dev-1.json");
    expect(readPrefixes()).toEqual(["kesonode_", "konode_"]);
    expect(listPrefixes("bookmarks")).toEqual(["kesonode_bookmarks_", "konode_bookmarks_"]);
    expect(isPeerFileName("kesonode_bookmarks_dev-1.json", "bookmarks")).toBe(true);
    expect(isPeerFileName("konode_bookmarks_dev-2.json", "bookmarks")).toBe(true);
    expect(peerDeviceIdFromName("konode_bookmarks_dev-2.json", "bookmarks")).toBe("dev-2");
    expect(deviceFilePattern().exec("kesonode_history_dev-9.json")?.[2]).toBe("dev-9");
  });

  it("keeps restore points in the shared upstream namespace", () => {
    setCompatMode("isolated");
    expect(snapshotFileName(1_700_000_000_000)).toBe("konode_snap_bookmarks_1700000000000.json");
    expect(snapshotTimestamp("konode_snap_bookmarks_1700000000000.json")).toBe(1_700_000_000_000);
    expect(snapshotTimestamp("konode_snap_index.json")).toBeNull();
  });

  it("falls back to upstream for anything that is not the isolated value", () => {
    setCompatMode("isolated");
    setCompatMode("something-else" as "upstream");
    expect(getCompatMode()).toBe("upstream");
  });
});

describe("packet version negotiation", () => {
  it("accepts the upstream version and legacy packets without a version", () => {
    expect(() => assertSupportedPacketVersion({ version: "1.0" })).not.toThrow();
    expect(() => assertSupportedPacketVersion({})).not.toThrow();
    expect(() => assertSupportedPacketVersion({ version: undefined })).not.toThrow();
    expect(() => assertSupportedPacketVersion({ version: "" })).not.toThrow();
  });

  it("refuses a version whose rules this build does not implement", () => {
    expect(() => assertSupportedPacketVersion({ version: "2.0" })).toThrow(/Unsupported sync packet version/);
    expect(() => assertSupportedPacketVersion({ version: 2 })).toThrow(/Unsupported sync packet version/);
    expect(() => assertSupportedPacketVersion({ version: { major: 9 } })).toThrow(/Unsupported/);
  });
});
