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

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

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

/** The folder a path lives in, created if it is not there yet. */
async function ensureFolder(
  dir: DirectoryHandleLike,
  segments: string[]
): Promise<DirectoryHandleLike> {
  let current = dir;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

/** Write one file, creating the folders above it. */
async function writeFile(
  dir: DirectoryHandleLike,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const parts = path.split("/");
  const name = parts.pop();
  if (!name) throw new Error(`bad path ${path}`);
  const folder = await ensureFolder(dir, parts);
  const handle = await folder.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

/** Copy every installed file into the backup folder, keeping the layout. */
async function makeBackup(
  dir: DirectoryHandleLike,
  version: string
): Promise<{ backup: string; count: number }> {
  const backup = `${BACKUP_DIR}/${version}`;
  const files = await listFiles(dir);
  for (const file of files) {
    const source = await file.handle.getFile();
    const bytes = new Uint8Array(await source.arrayBuffer());
    await writeFile(dir, `${backup}/${file.path}`, bytes);
  }
  return { backup, count: files.length };
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
  pkg: ExtractedPackage
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
  let written = 0;
  try {
    if (previousVersion) {
      const made = await makeBackup(dir, previousVersion);
      backup = made.backup;
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

  try {
    // The manifest goes last, on purpose — see the note at the top of this file.
    const manifestEntry = pkg.entries.find((e) => e.path === "manifest.json");
    for (const entry of pkg.entries) {
      if (entry.path === "manifest.json") continue;
      await writeFile(dir, entry.path, entry.bytes);
      written += 1;
    }
    if (!manifestEntry) throw new Error("the package has no manifest.json");
    await writeFile(dir, "manifest.json", manifestEntry.bytes);
    written += 1;
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

  // Now the leftovers. A file the new package does not have is a chunk from an older
  // release: nothing loads it, and every one of them makes the folder bigger.
  let removed = 0;
  const wanted = new Set(pkg.entries.map((e) => e.path));
  try {
    const stale = await listFiles(dir);
    for (const file of stale) {
      if (wanted.has(file.path)) continue;
      if (file.path.startsWith(`${BACKUP_DIR}/`)) continue;
      const parts = file.path.split("/");
      const name = parts.pop();
      if (!name) continue;
      const folder = await ensureFolder(dir, parts);
      await folder.removeEntry(name);
      removed += 1;
    }
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
