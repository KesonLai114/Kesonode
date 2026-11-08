import { withChecksum, verifyChecksum } from "@/lib/utils/checksum";

/**
 * The portable data export (`kesonode-backup-<date>.json`). This is a DIFFERENT format
 * from the settings backup in utils/storage.ts, and unrelated to the SyncPacket wire
 * contract frozen in compat/protocol.ts. It carries bookmarks, the extension list and
 * history as plain JSON.
 *
 * Compatibility rule: only add OPTIONAL fields. `format` is one — older builds ignore
 * it, so a file written here still opens there. Never change the meaning of
 * `data.bookmarks` / `data.history` while `version` stays "1.0".
 */

export const DATA_BACKUP_FORMAT = "kesonode-data";
export const DATA_BACKUP_VERSION = "1.0";
export const SUPPORTED_DATA_BACKUP_VERSIONS: readonly string[] = [DATA_BACKUP_VERSION];

export interface DataBackupBookmarkNode {
  url?: string;
  title?: string;
  children?: DataBackupBookmarkNode[];
}

export interface DataBackupHistoryItem {
  url?: string;
}

export interface DataBackupPayload {
  bookmarks: DataBackupBookmarkNode[];
  history: DataBackupHistoryItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one place that writes the envelope, so format/version/checksum cannot drift from the reader. */
export async function buildDataBackup(
  data: Record<string, unknown>,
  device: string
): Promise<Record<string, unknown>> {
  return withChecksum({
    format: DATA_BACKUP_FORMAT,
    version: DATA_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    device,
    data,
  });
}

/**
 * Validate and normalise an untrusted import. A future format is REFUSED with an
 * actionable error instead of being parsed under rules that may no longer apply; every
 * older layout is still read.
 */
export async function readDataBackup(input: unknown): Promise<DataBackupPayload> {
  if (!isRecord(input)) throw new Error("This is not a Kesonode data backup.");

  // Optional on purpose: every file written before `format` existed has none, and those
  // must keep opening. A PRESENT but different format is simply a different file (a
  // settings backup, a browser bookmark export, ...), not an older version of this one.
  if (input.format !== undefined && input.format !== DATA_BACKUP_FORMAT) {
    throw new Error("This is not a Kesonode data backup.");
  }

  const version = input.version;
  if (version === undefined || version === null || version === "") {
    throw new Error("Invalid Kesonode backup file: no format version.");
  }
  if (typeof version !== "string" || !SUPPORTED_DATA_BACKUP_VERSIONS.includes(version)) {
    throw new Error(
      `This data backup was written by a newer Kesonode (format ${String(version)}). ` +
        `Update Kesonode to import it; this build reads ${SUPPORTED_DATA_BACKUP_VERSIONS.join(", ")}.`
    );
  }

  // After the format/version gate, so a newer file is reported as newer rather than as
  // damaged. A missing checksum means a file written before the field existed: readable.
  await verifyChecksum(input);

  // Old layout had the arrays at the top level; the current one wraps them in `data`.
  const data = input.data ?? input;
  if (!isRecord(data)) throw new Error("Invalid Kesonode backup file: no data.");

  const rawBookmarks = Array.isArray(data.bookmarks)
    ? data.bookmarks
    : isRecord(data.bookmarks) ? [data.bookmarks] : [];
  const rawHistory = Array.isArray(data.history) ? data.history : [];

  // A damaged entry must not abort an otherwise good import. `isRecord` drops null,
  // strings and numbers before the importer touches `.url` / `.children`.
  return {
    bookmarks: rawBookmarks.filter(isRecord) as unknown as DataBackupBookmarkNode[],
    history: rawHistory.filter(isRecord) as unknown as DataBackupHistoryItem[],
  };
}
