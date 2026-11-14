/**
 * Inspect and unpack a downloaded Kesonode release zip — read-only, and without running
 * any of it.
 *
 * A browser extension cannot replace its own code on its own (the package directory is
 * read-only and MV3 forbids executing code that isn't part of the package), so this
 * module never installs anything by itself. It does two things: it answers whether the
 * file the user picked is a genuine, newer Kesonode package for the browser they are
 * running, and it hands back the package's files so the caller can put them somewhere.
 *
 * Deliberately dependency-free. Only the one file we need is inflated, through the
 * platform's `DecompressionStream("deflate-raw")`; with a stored (method 0) manifest —
 * which is what the tests use — no stream API is involved at all. ZIP64 is refused: a
 * release package is ~1.5 MB and has no reason to need it, and refusing keeps the parser
 * small enough to audit.
 *
 * Two archive layouts have to work, because Kesonode ships both:
 *
 *  - The Chrome Web Store package puts `manifest.json` at the root of the archive,
 *    because the store requires it there.
 *  - The package people download has a single folder at the top (`Kesonode/…`), so that
 *    unzipping it produces ONE folder with a fixed name instead of a pile of loose
 *    files. The folder is what the browser loads, and its name never changes between
 *    versions — which is what makes "upgrade by overwriting the same folder" possible.
 *
 * So the parser finds the single top-level folder and treats what is inside it as the
 * package. Both layouts therefore read the same from here on.
 */

export type PackageTarget = "chromium" | "firefox" | "unknown";

/** Why a selected file must not be handed to the upgrade code. */
export type BadReason = "unsafe" | "zip" | "browser" | "version";

/**
 * A sound package that is simply not newer is information, not a failure.
 *
 * The old settings page ran it through the same "this package cannot be used" message as
 * a damaged zip, so re-picking the version already installed looked like an error. The
 * one-button flow shows it as a neutral "nothing to upgrade" instead.
 */
export function packageIssueKind(reason: BadReason): "no-change" | "bad" {
  return reason === "version" ? "no-change" : "bad";
}

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

/** One file of the package, with its bytes. */
export interface PackageEntry {
  /** Path inside the package: "/" separators, no leading "./", no top-level folder. */
  path: string;
  bytes: Uint8Array;
}

/** A package that was read and checked, ready to be written somewhere. */
export interface ExtractedPackage {
  version: string;
  target: PackageTarget;
  /**
   * The `key` the manifest pins, or null when the manifest carries none.
   *
   * The key is what decides the extension's ID. Two installs with the same key are the
   * same extension wherever they live; an install without one is named after its folder.
   * A package that would change the key would change the ID, and with it every setting
   * the user has — so the caller checks this against the INSTALLED manifest before
   * writing anything.
   */
  manifestKey: string | null;
  entries: PackageEntry[];
}

export type ExtractResult =
  | { ok: true; package: ExtractedPackage }
  | { ok: false; reason: BadReason };

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
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

/**
 * A path that tried to escape the destination.
 *
 * This one is worth telling apart from every other failure: a broken archive is the
 * user's file being damaged, while this is a package trying to write outside its own
 * folder — worth saying out loud, and worth refusing for that reason alone.
 */
class UnsafeArchiveError extends Error {}

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
  key?: unknown;
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

/**
 * The one top-level folder of the archive, if it has one.
 *
 * "Kesonode/manifest.json" and "Kesonode/chunks/x.js" share the folder "Kesonode";
 * a store package has no shared first segment at all — its manifest sits at the root.
 * The test is therefore "does EVERY entry live inside the same folder": a root file
 * means the flat layout, and two different first segments mean a layout we do not
 * recognise, in which case the caller gets "" and the paths simply do not resolve to
 * a manifest.
 */
function topLevelFolder(names: string[]): string {
  const first = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const slash = name.indexOf("/");
    // A file at the root: this is the store layout, not a folder.
    if (slash < 0) return "";
    first.add(name.slice(0, slash));
  }
  if (first.size !== 1) return "";
  return [...first][0];
}

/** A Blob-like object; keeps the module free of DOM `File` in tests. */
export interface PackageFile {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ReadArchive {
  view: DataView;
  bytes: Uint8Array;
  entries: ZipEntry[];
  /** The folder inside the archive that holds the package, or "" for a flat archive. */
  prefix: string;
}

function readArchive(view: DataView, bytes: Uint8Array): ReadArchive {
  const entries = readEntries(view, bytes, findEocd(view));
  if (entries.some((e) => unsafeName(e.name))) throw new UnsafeArchiveError("unsafe path");
  const prefix = topLevelFolder(entries.map((e) => normaliseName(e.name)));
  return { view, bytes, entries, prefix };
}

/** The entry that holds the package's manifest, or null when there is none. */
function manifestEntry(archive: ReadArchive): ZipEntry | null {
  const wanted = archive.prefix ? `${archive.prefix}/manifest.json` : "manifest.json";
  return (
    archive.entries.find((e) => normaliseName(e.name) === wanted) ??
    archive.entries.find((e) => normaliseName(e.name) === "manifest.json") ??
    null
  );
}

function parseManifest(raw: Uint8Array): PackageManifest {
  return JSON.parse(new TextDecoder().decode(raw)) as PackageManifest;
}

function readManifestInfo(manifest: PackageManifest): {
  version: string;
  target: PackageTarget;
  key: string | null;
} | null {
  if (manifest?.manifest_version !== 3 || typeof manifest.version !== "string") return null;
  const version = manifest.version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const key = typeof manifest.key === "string" && manifest.key.length > 0 ? manifest.key : null;
  return { version, target: detectTarget(manifest), key };
}

export async function inspectUpgradePackage(
  file: PackageFile,
  options: InspectOptions
): Promise<UpgradeInspection> {
  if (!file.size || file.size > MAX_BYTES) return { ok: false, reason: "zip" };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const archive = readArchive(view, bytes);

    const entry = manifestEntry(archive);
    // A package without an HTML entry point is a partial download, not an upgrade.
    if (!entry || !archive.entries.some((e) => normaliseName(e.name).endsWith(".html"))) {
      return { ok: false, reason: "zip" };
    }

    const raw = await readEntry(view, bytes, entry, options.inflate ?? defaultInflate);
    const info = readManifestInfo(parseManifest(raw));
    if (!info) return { ok: false, reason: "zip" };

    if (
      options.currentTarget !== "unknown" &&
      info.target !== "unknown" &&
      info.target !== options.currentTarget
    ) {
      return { ok: false, reason: "browser" };
    }
    if (compareVersions(info.version, options.currentVersion) <= 0) {
      return { ok: false, reason: "version" };
    }
    return { ok: true, version: info.version, target: info.target, entries: archive.entries.length };
  } catch (error) {
    // A truncated zip, a bad deflate stream, invalid JSON — all the same answer to the
    // user: this is not a usable package. Never surface a parser stack trace in the UI.
    if (error instanceof UnsafeArchiveError) return { ok: false, reason: "unsafe" };
    return { ok: false, reason: "zip" };
  }
}

/**
 * Read the whole package out of the zip.
 *
 * Everything the caller needs to write the package somewhere: the files with their
 * bytes, the version, the browser it is for, and the `key` that decides the extension
 * ID. The checks are the same ones `inspectUpgradePackage` makes — this is the "and now
 * give me the files" half, not a second opinion about whether the package is usable.
 */
export async function extractPackage(
  file: PackageFile,
  options: InspectOptions
): Promise<ExtractResult> {
  if (!file.size || file.size > MAX_BYTES) return { ok: false, reason: "zip" };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const archive = readArchive(view, bytes);
    const inflate = options.inflate ?? defaultInflate;

    const entry = manifestEntry(archive);
    if (!entry || !archive.entries.some((e) => normaliseName(e.name).endsWith(".html"))) {
      return { ok: false, reason: "zip" };
    }
    const raw = await readEntry(view, bytes, entry, inflate);
    const info = readManifestInfo(parseManifest(raw));
    if (!info) return { ok: false, reason: "zip" };

    if (
      options.currentTarget !== "unknown" &&
      info.target !== "unknown" &&
      info.target !== options.currentTarget
    ) {
      return { ok: false, reason: "browser" };
    }
    if (compareVersions(info.version, options.currentVersion) <= 0) {
      return { ok: false, reason: "version" };
    }

    const out: PackageEntry[] = [];
    let total = 0;
    for (const item of archive.entries) {
      const name = normaliseName(item.name);
      // Folder entries carry no data; the writer creates folders as it needs them.
      if (!name || name.endsWith("/")) continue;
      const path = archive.prefix && name.startsWith(archive.prefix)
        ? name.slice(archive.prefix.length).replace(/^\/+/, "")
        : name;
      if (!path) continue;
      const data = await readEntry(view, bytes, item, inflate);
      total += data.byteLength;
      if (total > MAX_TOTAL_BYTES) return { ok: false, reason: "zip" };
      out.push({ path, bytes: data });
    }
    if (!out.length) return { ok: false, reason: "zip" };

    return {
      ok: true,
      package: {
        version: info.version,
        target: info.target,
        manifestKey: info.key,
        entries: out,
      },
    };
  } catch (error) {
    if (error instanceof UnsafeArchiveError) return { ok: false, reason: "unsafe" };
    return { ok: false, reason: "zip" };
  }
}
