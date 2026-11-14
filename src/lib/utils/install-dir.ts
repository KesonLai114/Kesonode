/**
 * The folder Kesonode is installed in, and the permission to write to it.
 *
 * A browser extension may not write to its own package directory — Chromium's
 * `runtime.getPackageDirectoryEntry()` hands out a read-only view by design. What the
 * platform DOES offer is the File System Access API: the user picks a folder once, the
 * page keeps a handle to it, and from then on the extension can create, overwrite and
 * delete files in it.
 *
 * That is the whole trick behind the one-click upgrade. The handle points at the very
 * folder the browser loads the extension from, so the upgrade writes the new version
 * where the browser will look for it, and `runtime.reload()` makes the browser look
 * again.
 *
 * Two things this module refuses to do:
 *
 *  - It never picks a folder for the user. `showDirectoryPicker()` needs a real user
 *    gesture and shows the browser's own dialog; the extension cannot open it on its
 *    own, and it cannot learn the path of the folder the extension runs from — the
 *    platform deliberately keeps that to itself.
 *  - It never asks for more than it needs. The permission is per folder, it is
 *    remembered by the browser, and it can be revoked by the user at any time, so every
 *    use re-checks it rather than assuming yesterday's answer still holds.
 *
 * Chromium only. Firefox has no `showDirectoryPicker()` at all, and Safari neither —
 * `supportsFolderWrite()` is how the UI asks before it offers the feature.
 */

/** A file inside the folder, as much of it as the upgrade code needs. */
export interface FileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<{
    write(data: Uint8Array | ArrayBuffer | string): Promise<void>;
    close(): Promise<void>;
  }>;
}

/** A folder inside the folder. */
export interface DirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, FileHandleLike | DirectoryHandleLike]>;
  values(): AsyncIterableIterator<FileHandleLike | DirectoryHandleLike>;
}

/** Where the handle is kept between sessions. */
const DB_NAME = "kesonode";
const STORE = "upgrade";
const KEY = "install_folder";

/**
 * Whether this browser can hand out a writable folder at all.
 *
 * `showDirectoryPicker()` exists in Chromium (Chrome 86+, Edge, Opera, Brave and the
 * other Chromium browsers) and in NO other engine: Firefox has never implemented it,
 * and neither has Safari. The check is a function lookup rather than a user-agent
 * sniff, because the API being missing is the thing that actually matters.
 */
export function supportsFolderWrite(): boolean {
  if (typeof window === "undefined") return false;
  const picker = (window as unknown as {
    showDirectoryPicker?: unknown;
  }).showDirectoryPicker;
  return typeof picker === "function";
}

interface PickerWindow {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
    id?: string;
  }) => Promise<DirectoryHandleLike>;
}

/**
 * Ask the user for the folder Kesonode is installed in.
 *
 * Must be called from a user gesture: the browser throws a SecurityError otherwise.
 * The dialog starts in the last folder the user picked for this id, which is why the id
 * is a stable name rather than something generated per call.
 */
export async function pickInstallFolder(): Promise<DirectoryHandleLike> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("showDirectoryPicker is not available");
  return picker.call(window, { mode: "readwrite", id: "kesonode-install-folder" });
}

/**
 * Whether the extension may write to this folder right now.
 *
 * "granted" — yes. "denied" — the user said no, or revoked it; asking again would
 * only show the same answer. "prompt" — the browser needs a gesture to re-ask, which
 * this call site always has (the user just pressed a button).
 */
export async function ensureWritePermission(
  handle: DirectoryHandleLike
): Promise<boolean> {
  const askable = handle as DirectoryHandleLike & {
    queryPermission?: (descriptor: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: string }) => Promise<PermissionState>;
  };
  if (typeof askable.queryPermission !== "function") return true;
  try {
    let state = await askable.queryPermission({ mode: "readwrite" });
    if (state === "prompt" && typeof askable.requestPermission === "function") {
      state = await askable.requestPermission({ mode: "readwrite" });
    }
    return state === "granted";
  } catch {
    return false;
  }
}

// ─── Remembering the handle ─────────────────────────────────────────────────

/**
 * The handle is kept in IndexedDB, not in `storage.local`.
 *
 * `storage.local` only stores JSON, and a directory handle is not JSON. IndexedDB
 * stores it by structured clone, which the File System Access API supports for exactly
 * this purpose. The handle is bound to the extension's origin, and the extension's ID
 * is pinned by the manifest's `key`, so the handle survives the upgrade that rewrites
 * the very folder it points at.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB refused"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

/** Remember the folder the user picked. */
export async function saveInstallFolder(handle: DirectoryHandleLike): Promise<void> {
  await withStore("readwrite", (store) => store.put(handle, KEY));
}

/** The remembered folder, or null when there is none (or the browser dropped it). */
export async function loadInstallFolder(): Promise<DirectoryHandleLike | null> {
  try {
    const stored = await withStore<unknown>("readonly", (store) => store.get(KEY));
    if (!stored || typeof stored !== "object") return null;
    const handle = stored as DirectoryHandleLike;
    return handle.kind === "directory" ? handle : null;
  } catch {
    // A browser without IndexedDB, a private window that refuses to keep one, a handle
    // the browser has dropped: all of them mean "no remembered folder", not an error
    // worth putting in front of the user.
    return null;
  }
}

/** Forget the remembered folder — the user pointed it at the wrong place. */
export async function forgetInstallFolder(): Promise<void> {
  try {
    await withStore("readwrite", (store) => store.delete(KEY));
  } catch {
    // Nothing to forget if the store is unusable; the folder is gone either way.
  }
}
