/**
 * The upstream wire contract — Kesonode's explicit compatibility interface.
 *
 * Kesonode is a fork of Konode v1.5.1. Everything below is DATA that travels between
 * devices (or identifies where that data lives), not product copy: changing any of it
 * silently splits a sync group. Collected here so future work has one place to look, one
 * place to assert in tests, and one switch to flip.
 *
 * Three modes:
 *  - "upstream" (default): read AND write the exact upstream namespace, in the upstream
 *    `konode` folder. A Kesonode device and a Konode device pointed at the same backend
 *    sync with each other with no adapter at all. Every existing installation is here.
 *  - "isolated": still the upstream folder, but write Kesonode-named files while reading
 *    BOTH namespaces. It stops publishing into the upstream namespace without losing the
 *    data already sitting there.
 *  - "standalone": Kesonode's own folder (`kesonode`, `Kesonode` on Drive) AND its own
 *    file names, reading only those. A separate sync group: no double-read, and no
 *    upstream device can see it.
 *
 * The extension ID, OAuth client, redirect URI, local storage keys, encryption parameters
 * and the FILE FORMAT are fixed by the installed extension's identity and the upstream
 * wire contract; see the fork notice in the README before touching any of them. The
 * folder name is different: UPSTREAM_PROTOCOL's values stay byte-for-byte frozen, and
 * `standalone` picks a second, separate pair from KESONODE_FOLDER instead. Devices in one
 * sync group must all pick the same mode — the folder is where they find each other.
 */
import type { DataType } from "@/lib/types";

/** Frozen, byte-for-byte description of the Konode v1.5.1 wire format. */
export const UPSTREAM_PROTOCOL = Object.freeze({
  packetVersion: "1.0",
  packetFilePrefix: "konode_",
  snapshotFilePrefix: "konode_snap_bookmarks_",
  snapshotIndexName: "konode_snap_index.json",
  driveFolderName: "Konode",
  defaultBackendPath: "konode",
  legacyVerifier: "konode-verify-v1",
  storageKeyPrefix: "konode_",
  alarms: Object.freeze({
    sync: "konode-sync",
    bookmarkSync: "konode-bookmark-sync",
  }),
  crypto: Object.freeze({
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: 600_000,
    saltBytes: 16,
    ivBytes: 12,
    checksum: "SHA-256",
  }),
} as const);

/** The namespace Kesonode writes to when it is not publishing as an upstream peer. */
export const ISOLATED_FILE_PREFIX = "kesonode_";

/**
 * The folder names `standalone` mode uses. Separate from UPSTREAM_PROTOCOL on purpose:
 * those two values are frozen wire data, these are NEW data for a NEW mode. Drive keeps
 * the capitalised spelling upstream uses, WebDAV/GitHub keep the lowercase one.
 */
export const KESONODE_FOLDER = Object.freeze({
  driveFolderName: "Kesonode",
  defaultBackendPath: "kesonode",
} as const);

export type CompatMode = "upstream" | "isolated" | "standalone";

/**
 * Packet versions this build knows how to read. A packet carrying anything else is
 * rejected at the door instead of being parsed under rules that may no longer apply.
 */
export const SUPPORTED_PACKET_VERSIONS: readonly string[] = [UPSTREAM_PROTOCOL.packetVersion];
export const CURRENT_PACKET_VERSION = UPSTREAM_PROTOCOL.packetVersion;

// One extension runtime has one settings object and one active mode. The engine sets it
// from settings on construction, and saveSettings() applies a user change immediately.
let activeMode: CompatMode = "upstream";

export function getCompatMode(): CompatMode {
  return activeMode;
}

export function setCompatMode(mode: CompatMode | null | undefined): void {
  activeMode = mode === "isolated" || mode === "standalone" ? mode : "upstream";
}

/** Test helper: back to the mode every existing installation uses. */
export function resetCompatMode(): void {
  activeMode = "upstream";
}

/**
 * The sync folder name, resolved the same way everywhere: backends use `folderPath()` /
 * `driveFolderName()` (the worker's live mode), the Settings page uses the pure `…For()`
 * form because it holds a settings object but not the worker's module state.
 */
export function folderPathFor(mode: CompatMode | null | undefined): string {
  return mode === "standalone"
    ? KESONODE_FOLDER.defaultBackendPath
    : UPSTREAM_PROTOCOL.defaultBackendPath;
}

export function folderPath(): string {
  return folderPathFor(activeMode);
}

export function driveFolderNameFor(mode: CompatMode | null | undefined): string {
  return mode === "standalone"
    ? KESONODE_FOLDER.driveFolderName
    : UPSTREAM_PROTOCOL.driveFolderName;
}

export function driveFolderName(): string {
  return driveFolderNameFor(activeMode);
}

/** The single namespace we WRITE. */
export function writePrefix(): string {
  return activeMode === "upstream" ? UPSTREAM_PROTOCOL.packetFilePrefix : ISOLATED_FILE_PREFIX;
}

/**
 * Namespaces we READ. `isolated` reads both (that is what "migration mode" means);
 * `standalone` reads only its own, so switching folders is a real split, not a
 * two-folder merge that quietly doubles every backend request.
 */
export function readPrefixes(): readonly string[] {
  if (activeMode === "upstream") return [UPSTREAM_PROTOCOL.packetFilePrefix];
  if (activeMode === "standalone") return [ISOLATED_FILE_PREFIX];
  return [ISOLATED_FILE_PREFIX, UPSTREAM_PROTOCOL.packetFilePrefix];
}

/** Prefixes to hand to IBackend.listFiles(), optionally narrowed to one data type. */
export function listPrefixes(dataType?: DataType): string[] {
  return readPrefixes().map((p) => `${p}${dataType ? `${dataType}_` : ""}`);
}

export function packetFileName(dataType: DataType, deviceId: string): string {
  return `${writePrefix()}${dataType}_${deviceId}.json`;
}

/** Device id from ANY readable peer file name, in either namespace, or null. */
export function peerDeviceIdFromName(name: string, dataType: DataType): string | null {
  for (const prefix of readPrefixes()) {
    const head = `${prefix}${dataType}_`;
    if (name.startsWith(head) && name.endsWith(".json")) {
      const id = name.slice(head.length, -".json".length);
      if (id) return id;
    }
  }
  return null;
}

export function isPeerFileName(name: string, dataType: DataType): boolean {
  return peerDeviceIdFromName(name, dataType) !== null;
}

/** Matches per-device files (not snapshots) in every readable namespace. */
export function deviceFilePattern(): RegExp {
  const alts = readPrefixes()
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`^(?:${alts})(bookmarks|history|sessions|extensions)_(.+)\\.json$`);
}

// Restore points are shared upstream data, not per-device packets: their names stay in
// the upstream namespace in both modes, so a Kesonode device can always restore a point
// taken by a Konode device (and vice versa).
export function snapshotFileName(timestamp: number): string {
  return `${UPSTREAM_PROTOCOL.snapshotFilePrefix}${timestamp}.json`;
}

export function snapshotTimestamp(name: string): number | null {
  const head = UPSTREAM_PROTOCOL.snapshotFilePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${head}(\\d+)\\.json$`).exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * Version negotiation for incoming packets.
 *
 * A missing version means a packet written before the field existed — still perfectly
 * valid upstream data, so it is accepted. A PRESENT but unknown version is refused: the
 * checksum alone cannot tell us that the payload uses rules we don't implement.
 */
export function assertSupportedPacketVersion(packet: { version?: unknown }): void {
  const version = packet.version;
  if (version === undefined || version === null || version === "") return;
  if (typeof version !== "string" || !SUPPORTED_PACKET_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported sync packet version "${String(version)}". ` +
        `This build reads ${SUPPORTED_PACKET_VERSIONS.join(", ")} packets; refusing to import unverified data.`
    );
  }
}
