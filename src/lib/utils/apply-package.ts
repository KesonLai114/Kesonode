/**
 * Write a new Kesonode package over the folder the browser loads the extension from.
 *
 * The order of operations is the whole design, so it is worth stating plainly:
 *
 *  1. Read the INSTALLED manifest and compare its `key` with the package's. The key
 *     decides the extension ID, and an ID change would take every setting, every
 *     backend login and every snapshot with it. Nothing is written before this
 *     matches.
 *  2. Copy the installed files into `.kesonode-backup/<version>/` inside the folder.
 *     The extension is about to be overwritten in place, and the only honest way to
 *     offer "undo" is to keep the old files next to the new ones. The backup lives
 *     inside the folder because that is the only place the extension is allowed to
 *     write, and it is skipped when the next upgrade walks the folder.
 *  3. Write the new files, the manifest LAST. The manifest is the file the browser
 *     reads to decide what the extension is; if it arrives before the code it
 *     describes, a reload in between would load a manifest pointing at files that are
 *     not there yet.
 *  4. Delete the files the new package does not have. Vite names its chunks after
 *     their contents, so every release leaves chunks behind that the next one does not
 *     use. Leaving them costs disk and, worse, makes "what is in this folder" a
 *     question with several answers.
 *
 * Performance notes (why an upgrade used to feel stuck):
 *
 *  - The folder is typically an SMB-mounted directory, so every `getFileHandle`,
 *    `createWritable`, `write` and `close` is a network round-trip. Doing them one
 *    at a time serialises all that latency. Writes now run with bounded concurrency
 *    and reuse already-resolved parent-directory handles, which removes most of the
 *    per-file round-trips.
 *  - The backup used to COPY every installed file (read + write) before writing the
 *    new ones — that doubles the I/O. When the folder supports `moveEntry` (Chrome
 *    113+) the backup instead RENAMES the top-level entries into the backup folder,
 *    which is a handful of metadata operations instead of hundreds of file copies.
 *    Where `moveEntry` is missing, the copy backup remains as a fallback.
 *  - A progress callback reports the phase and a `done/total` count so the UI can
 *    show a bar instead of an indeterminate spinner.
 *
 * If a write fails half-way, the extension is NOT reloaded: the browser keeps running
 * the code it already loaded, and the folder is a mixture. The upgrade can simply be
 * run again — it writes the same files — and the backup is there if the folder has to
 * be put back by hand.
 */

import type { ExtractedPackage } from "@/lib/utils/upgrade-package";
import type { DirectoryHandleLike, FileHandleLike } from "@/lib/utils/install-dir";

/** Why an upgrade could not be carried out. */
export type ApplyFailure =
  /** The chosen folder is not a Kesonode install (no manifest.json in it). */
  | "not_installed"
  /** The package would change the extension ID, and with it every setting. */
  | "key_mismatch"
  /** The installed manifest could not be read. */
  | "read"
  /** A file could not be written, or the backup could not be made. */
  | "write";

/** Which stage of the install the progress callback is reporting. */
export type ApplyPhase = "backup" | "write" | "cleanup";

/** Progress for one stage of the install. */
export interface ApplyProgress {
  phase: ApplyPhase;
  /** Items finished in this stage. */
  done: number;
  /** Items expected in this stage. */
  total: number;
}

export interface ApplyOutcome {
  ok: boolean;
  failure?: ApplyFailure;
  /** Detail for the log. Never shown raw to the user. */
  reason?: string;
  /** The version that was installed before this ran. */
  previousVersion?: string;
  /** The version that is installed now. */
  version?: string;
  written: number;
  removed: number;
  /** Where the old files were kept, relative to the install folder. */
  backup?: string;
}

/** The folder inside the install folder that holds the previous version. */
export const BACKUP_DIR = ".kesonode-backup";

/** How many file writes run at once. Latency on a remote folder is the bottleneck. */
const WRITE_CONCURRENCY = 8;

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/** A directory handle that may support moving a child entry (Chrome 113+). */
type MovableDir = DirectoryHandleLike & {
  moveEntry?: (
    name: string,
    destination: DirectoryHandleLike,
    options?: { name?: string }
  ) => Promise<void>;
};

/** Every file in the folder, as paths relative to it. Skips the backup folder. */
async function listFiles(
  dir: DirectoryHandleLike,
  prefix = ""
): Promise<{ path: string; handle: FileHandleLike }[]> {
  const out: { path: string; handle: FileHandleLike }[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (prefix === "" && name === BACKUP_DIR) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      out.push(...(await listFiles(handle, path)));
    } else {
      out.push({ path, handle });
    }
  }
  return out;
}

/**
 * A short-lived cache of directory handles, keyed by their path from the install root.
 *
 * `writeFile` used to call `getDirectoryHandle(segment, { create: true })` for every
 * segment of every file, so files in the same directory re-resolved the same parent
 * dozens of times — and each resolution is a round-trip on a remote folder. Resolving
 * a path once and remembering it removes almost all of that.
 */
function makeDirCache(dir: DirectoryHandleLike) {
  const cache = new Map<string, DirectoryHandleLike>();
  cache.set("", dir);
  return {
    async get(segments: string[]): Promise<DirectoryHandleLike> {
      let current = dir;
      let path = "";
      for (const segment of segments) {
        path = path ? `${path}/${segment}` : segment;
        const hit = cache.get(path);
        if (hit) {
          current = hit;
          continue;
        }
        current = await current.getDirectoryHandle(segment, { create: true });
        cache.set(path, current);
      }
      return current;
    },
  };
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/** Write one file, creating the folders above it via the shared cache. */
async function writeFile(
  cache: ReturnType<typeof makeDirCache>,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const parts = path.split("/");
  const name = parts.pop();
  if (!name) throw new Error(`bad path ${path}`);
  const folder = await cache.get(parts);
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

/**
 * Back up by RENAMING the install's top-level entries into the backup folder.
 *
 * Returns null when the folder cannot move entries, so the caller falls back to a copy.
 * The manifest is deliberately left in place here and moved LAST (after the new files
 * are written) so that a write failure mid-upgrade still leaves the old manifest
 * loadable — the same guarantee the copy backup gives by overwriting it last.
 */
async function makeBackupByMove(
  dir: DirectoryHandleLike,
  version: string
): Promise<{ backup: string; target: DirectoryHandleLike; count: number } | null> {
  const movable = dir as MovableDir;
  if (typeof movable.moveEntry !== "function") return null;
  const cache = makeDirCache(dir);
  const target = await cache.get([BACKUP_DIR, version]);
  const names: string[] = [];
  for await (const [name] of dir.entries()) {
    if (name === BACKUP_DIR || name === "manifest.json") continue;
    names.push(name);
  }
  let count = 0;
  for (const name of names) {
    await movable.moveEntry(name, target, { name });
    count += 1;
  }
  return { backup: `${BACKUP_DIR}/${version}`, target, count };
}

/**
 * Fallback backup: copy every installed file into the backup folder.
 *
 * Slower than the rename path, but works everywhere. Runs concurrently with the
 * shared directory cache so it is still far cheaper than the original serial copy.
 */
async function makeBackupCopy(
  dir: DirectoryHandleLike,
  version: string,
  onProgress?: (progress: ApplyProgress) => void
): Promise<{ backup: string; count: number }> {
  const cache = makeDirCache(dir);
  const files = await listFiles(dir);
  onProgress?.({ phase: "backup", done: 0, total: files.length });
  let count = 0;
  await mapWithConcurrency(files, WRITE_CONCURRENCY, async (file) => {
    const source = await file.handle.getFile();
    const bytes = new Uint8Array(await source.arrayBuffer());
    await writeFile(cache, `${BACKUP_DIR}/${version}/${file.path}`, bytes);
    count += 1;
    onProgress?.({ phase: "backup", done: count, total: files.length });
  });
  return { backup: `${BACKUP_DIR}/${version}`, count };
}

/**
 * Put the package in the folder.
 *
 * `package` has already been checked for version, browser and path safety by
 * `extractPackage`; what is left to do here is the part only this folder knows: is this
 * really the install, and will the new package keep the same extension ID?
 */
export async function applyPackageToFolder(
  dir: DirectoryHandleLike,
  pkg: ExtractedPackage,
  onProgress?: (progress: ApplyProgress) => void
): Promise<ApplyOutcome> {
  let installedRaw: string;
  try {
    const handle = await dir.getFileHandle("manifest.json");
    const file = await handle.getFile();
    installedRaw = await file.text();
  } catch (error) {
    return {
      ok: false,
      failure: isMissing(error) ? "not_installed" : "read",
      reason: error instanceof Error ? error.message : String(error),
      written: 0,
      removed: 0,
    };
  }

  let installed: { version?: unknown; key?: unknown };
  try {
    installed = JSON.parse(installedRaw) as { version?: unknown; key?: unknown };
  } catch (error) {
    return {
      ok: false,
      failure: "read",
      reason: error instanceof Error ? error.message : String(error),
      written: 0,
      removed: 0,
    };
  }

  const installedKey = typeof installed.key === "string" && installed.key.length > 0
    ? installed.key
    : null;
  // Same key, or neither has one: the extension keeps its ID. A package that adds or
  // drops the key renames the extension, and the user's settings go with it.
  if (installedKey !== pkg.manifestKey) {
    return {
      ok: false,
      failure: "key_mismatch",
      reason: installedKey ? "installed pins an ID, the package does not" : "the package pins an ID, the install does not",
      previousVersion: typeof installed.version === "string" ? installed.version : undefined,
      written: 0,
      removed: 0,
    };
  }

  const previousVersion = typeof installed.version === "string" ? installed.version : undefined;

  let backup: string | undefined;
  let backupTarget: DirectoryHandleLike | undefined;
  let backupByMove = false;
  try {
    if (previousVersion) {
      const moved = await makeBackupByMove(dir, previousVersion);
      if (moved) {
        backup = moved.backup;
        backupTarget = moved.target;
        backupByMove = true;
      } else {
        const made = await makeBackupCopy(dir, previousVersion, onProgress);
        backup = made.backup;
      }
    }
  } catch (error) {
    // No backup, no upgrade: the point of the copy is to be able to undo this.
    return {
      ok: false,
      failure: "write",
      reason: `backup failed: ${error instanceof Error ? error.message : String(error)}`,
      previousVersion,
      written: 0,
      removed: 0,
    };
  }

  const cache = makeDirCache(dir);
  const manifestEntry = pkg.entries.find((e) => e.path === "manifest.json");
  const others = pkg.entries.filter((e) => e.path !== "manifest.json");

  // Create every parent directory once, up front, so the concurrent writes below only
  // open files — never race on directory creation.
  const parentPaths = new Set(
    others.map((entry) => {
      const segments = entry.path.split("/");
      segments.pop();
      return segments.join("/");
    })
  );
  for (const parent of parentPaths) {
    if (parent) await cache.get(parent.split("/"));
  }

  let written = 0;
  const total = pkg.entries.length;
  onProgress?.({ phase: "write", done: 0, total });
  try {
    await mapWithConcurrency(others, WRITE_CONCURRENCY, async (entry) => {
      await writeFile(cache, entry.path, entry.bytes);
      written += 1;
      onProgress?.({ phase: "write", done: written, total });
    });
  } catch (error) {
    return {
      ok: false,
      failure: "write",
      reason: error instanceof Error ? error.message : String(error),
      previousVersion,
      version: pkg.version,
      written,
      removed: 0,
      backup,
    };
  }

  // With a rename backup the old manifest is still in place; move it now, after the new
  // code is on disk and before the new manifest overwrites it.
  if (backupByMove && backupTarget) {
    try {
      const movable = dir as MovableDir;
      if (typeof movable.moveEntry === "function") {
        await movable.moveEntry("manifest.json", backupTarget, { name: "manifest.json" });
      }
    } catch (error) {
      return {
        ok: false,
        failure: "write",
        reason: `manifest backup failed: ${error instanceof Error ? error.message : String(error)}`,
        previousVersion,
        version: pkg.version,
        written,
        removed: 0,
        backup,
      };
    }
  }

  if (!manifestEntry) throw new Error("the package has no manifest.json");
  await writeFile(cache, "manifest.json", manifestEntry.bytes);
  written += 1;
  onProgress?.({ phase: "write", done: written, total });

  // Now the leftovers. A file the new package does not have is a chunk from an older
  // release: nothing loads it, and every one of them makes the folder bigger. With a
  // rename backup there are none (the old entries were moved away), so this is mostly a
  // no-op there; with a copy backup it removes the previous release's stale chunks.
  let removed = 0;
  const wanted = new Set(pkg.entries.map((e) => e.path));
  try {
    const stale = await listFiles(dir);
    onProgress?.({ phase: "cleanup", done: 0, total: stale.length });
    for (const file of stale) {
      if (wanted.has(file.path)) continue;
      if (file.path.startsWith(`${BACKUP_DIR}/`)) continue;
      const parts = file.path.split("/");
      const name = parts.pop();
      if (!name) continue;
      const folder = await cache.get(parts);
      await folder.removeEntry(name);
      removed += 1;
    }
    onProgress?.({ phase: "cleanup", done: removed, total: stale.length });
  } catch (error) {
    // Leftovers are untidy, not fatal: the new version is in place and reloads fine.
    return {
      ok: true,
      reason: `some old files could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      previousVersion,
      version: pkg.version,
      written,
      removed,
      backup,
    };
  }

  return { ok: true, previousVersion, version: pkg.version, written, removed, backup };
}
