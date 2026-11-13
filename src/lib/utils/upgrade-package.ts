/**
 * Inspect a downloaded Kesonode release zip — read-only, and without running any of it.
 *
 * A browser extension cannot replace its own code (the package directory is read-only and
 * MV3 forbids executing code that isn't part of the package). This module therefore does
 * NOT install anything: it parses the zip's central directory, reads the root
 * `manifest.json`, and answers whether the file the user picked is a genuine, newer
 * Kesonode package for the browser they are running. The actual unpacking is done by the
 * companion `upgrade.sh` / `upgrade.bat` script outside the browser.
 *
 * Deliberately dependency-free. Only the one file we need is inflated, through the
 * platform's `DecompressionStream("deflate-raw")`; with a stored (method 0) manifest —
 * which is what the tests use — no stream API is involved at all. ZIP64 is refused: a
 * release package is ~400 KB and has no reason to need it, and refusing keeps the parser
 * small enough to audit.
 */

export type PackageTarget = "chromium" | "firefox" | "unknown";

/** Why a selected file must not be handed to the upgrade script. */
export type BadReason = "unsafe" | "zip" | "browser" | "version";

export type UpgradeInspection =
  | { ok: true; version: string; target: PackageTarget; entries: number }
  | { ok: false; reason: BadReason };

export interface InspectOptions {
  /** The version of the RUNNING extension, from `runtime.getManifest().version`. */
  currentVersion: string;
  /** Which browser this build is running in; "unknown" disables the target check. */
  currentTarget: PackageTarget;
  /** Injectable for tests. Defaults to `DecompressionStream("deflate-raw")`. */
  inflate?: (data: Uint8Array) => Promise<Uint8Array>;
}

const MAX_BYTES = 32 * 1024 * 1024;
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

interface Eocd {
  count: number;
  offset: number;
}

/**
 * Compare dotted numeric versions (the only shape this project releases: 1.5.18).
 * A leading `v` is tolerated because GitHub tags use it. Anything non-numeric sorts
 * below a number, so a malformed tag can never look newer than a real release.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value.trim().replace(/^v/i, "").split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

function findEocd(view: DataView): Eocd {
  // The end-of-central-directory record is 22 bytes plus an optional comment, so scan
  // backwards over the whole possible comment range instead of assuming it sits at EOF.
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let p = view.byteLength - 22; p >= earliest; p--) {
    if (view.getUint32(p, true) !== SIG_EOCD) continue;
    const count = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 12, true);
    const offset = view.getUint32(p + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new Error("ZIP64 is not supported");
    }
    return { count, offset };
  }
  throw new Error("no end-of-central-directory record");
}

function readEntries(view: DataView, bytes: Uint8Array, eocd: Eocd): ZipEntry[] {
  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = eocd.offset;
  for (let i = 0; i < eocd.count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error("bad central directory entry");
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > view.byteLength) throw new Error("truncated central directory");
    out.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method,
      compressedSize,
      localOffset,
    });
    p = end;
  }
  return out;
}

/** Normalise the harmless `./` prefix some zip tools emit, for comparisons only. */
function normaliseName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
}

/**
 * Reject anything that could make an unzip write outside its destination. The upgrade
 * script also checks this independently — two implementations, because the browser side
 * is the one the user sees first and the script is the one that actually touches disk.
 */
function unsafeName(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  return (
    n.includes("\0") ||
    /^[A-Za-z]:/.test(n) ||
    n.startsWith("/") ||
    n.split("/").includes("..")
  );
}

async function defaultInflate(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(
    new DecompressionStream("deflate-raw")
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readEntry(
  view: DataView,
  bytes: Uint8Array,
  entry: ZipEntry,
  inflate: (data: Uint8Array) => Promise<Uint8Array>
): Uint8Array | Promise<Uint8Array> {
  const p = entry.localOffset;
  if (p + 30 > view.byteLength || view.getUint32(p, true) !== SIG_LOCAL) {
    throw new Error("bad local file header");
  }
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  if (start + entry.compressedSize > view.byteLength) throw new Error("truncated entry");
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === METHOD_STORED) return data;
  if (entry.method === METHOD_DEFLATE) return inflate(data);
  throw new Error(`unsupported compression method ${entry.method}`);
}

interface PackageManifest {
  manifest_version?: unknown;
  version?: unknown;
  browser_specific_settings?: { gecko?: unknown } | undefined;
  background?: { service_worker?: unknown; scripts?: unknown } | undefined;
}

/** Firefox builds carry a gecko id and use `background.scripts`; Chromium uses a worker. */
function detectTarget(manifest: PackageManifest): PackageTarget {
  if (manifest.browser_specific_settings?.gecko) return "firefox";
  if (manifest.background?.service_worker) return "chromium";
  if (Array.isArray(manifest.background?.scripts)) return "firefox";
  return "unknown";
}

/** A Blob-like object; keeps the module free of DOM `File` in tests. */
export interface PackageFile {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function inspectUpgradePackage(
  file: PackageFile,
  options: InspectOptions
): Promise<UpgradeInspection> {
  if (!file.size || file.size > MAX_BYTES) return { ok: false, reason: "zip" };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = readEntries(view, bytes, findEocd(view));

    if (entries.some((e) => unsafeName(e.name))) return { ok: false, reason: "unsafe" };

    const manifestEntry = entries.find((e) => normaliseName(e.name) === "manifest.json");
    // A package without an HTML entry point is a partial download, not an upgrade.
    if (!manifestEntry || !entries.some((e) => normaliseName(e.name).endsWith(".html"))) {
      return { ok: false, reason: "zip" };
    }

    const raw = await readEntry(view, bytes, manifestEntry, options.inflate ?? defaultInflate);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as PackageManifest;
    if (parsed?.manifest_version !== 3 || typeof parsed.version !== "string") {
      return { ok: false, reason: "zip" };
    }
    const version = parsed.version.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: "zip" };

    const target = detectTarget(parsed);
    if (
      options.currentTarget !== "unknown" &&
      target !== "unknown" &&
      target !== options.currentTarget
    ) {
      return { ok: false, reason: "browser" };
    }
    if (compareVersions(version, options.currentVersion) <= 0) {
      return { ok: false, reason: "version" };
    }
    return { ok: true, version, target, entries: entries.length };
  } catch {
    // A truncated zip, a bad deflate stream, invalid JSON — all the same answer to the
    // user: this is not a usable package. Never surface a parser stack trace in the UI.
    return { ok: false, reason: "zip" };
  }
}
