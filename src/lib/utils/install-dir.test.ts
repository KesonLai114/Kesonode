import { describe, it, expect, afterEach } from "vitest";
import {
  ensureWritePermission,
  forgetInstallFolder,
  loadInstallFolder,
  pickInstallFolder,
  saveInstallFolder,
  supportsFolderWrite,
  type DirectoryHandleLike,
} from "@/lib/utils/install-dir";

/**
 * The folder handle is the one thing that has to survive between sessions, and the two
 * platform pieces it needs — `showDirectoryPicker()` and IndexedDB — are both missing in
 * the test environment. Both are faked here, but only as far as the module uses them:
 * the picker is a function that returns a handle, and IndexedDB is a map with the three
 * calls the module makes.
 */

function fakeDir(name: string): DirectoryHandleLike {
  return { kind: "directory", name } as DirectoryHandleLike;
}

const realWindow = (globalThis as { window?: unknown }).window;
const realIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;

afterEach(() => {
  if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
  if (realIndexedDb === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else (globalThis as { indexedDB?: unknown }).indexedDB = realIndexedDb;
});

function withWindow(picker: unknown): void {
  (globalThis as { window?: unknown }).window = { showDirectoryPicker: picker };
}

/** The smallest IndexedDB that satisfies the module: one store, three calls. */
function installFakeIndexedDb(): Map<string, unknown> {
  const data = new Map<string, unknown>();
  const request = <T>(value: T) => {
    const req = {
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      onupgradeneeded: null as null | (() => void),
      result: value as unknown,
      error: null,
    };
    // The handlers are assigned after the call returns, so the callback cannot fire
    // synchronously.
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  const store = {
    put: (value: unknown, key: string) => {
      data.set(key, value);
      return request(value);
    },
    get: (key: string) => request(data.get(key)),
    delete: (key: string) => {
      data.delete(key);
      return request(undefined);
    },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: () => ({ objectStore: () => store }),
    close: () => undefined,
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = { open: () => request(db) };
  return data;
}

describe("supportsFolderWrite", () => {
  it("is false where the browser has no such API", () => {
    // Node has no `window` at all, which is what Firefox looks like from here.
    expect(supportsFolderWrite()).toBe(false);
  });

  it("is false when the API is there but is not a function", () => {
    withWindow({ showDirectoryPicker: "nope" });
    expect(supportsFolderWrite()).toBe(false);
  });

  it("is true when the browser can hand out a writable folder", () => {
    withWindow(() => fakeDir("Kesonode"));
    expect(supportsFolderWrite()).toBe(true);
  });
});

describe("pickInstallFolder", () => {
  it("asks for a read-write folder under a stable id, so the picker reopens there", async () => {
    const calls: unknown[] = [];
    withWindow((options: unknown) => {
      calls.push(options);
      return fakeDir("Kesonode");
    });
    const handle = await pickInstallFolder();
    expect(handle.name).toBe("Kesonode");
    expect(calls).toEqual([{ mode: "readwrite", id: "kesonode-install-folder" }]);
  });

  it("refuses to pick anything where the API is missing", async () => {
    withWindow(undefined);
    await expect(pickInstallFolder()).rejects.toThrow();
  });
});

describe("ensureWritePermission", () => {
  it("trusts a handle that cannot say no", async () => {
    // Firefox has no permission API at all: the handle is usable or it is not.
    expect(await ensureWritePermission(fakeDir("Kesonode"))).toBe(true);
  });

  it("accepts a permission that is already granted, without asking again", async () => {
    let asked = false;
    const handle = {
      ...fakeDir("Kesonode"),
      queryPermission: async () => "granted" as PermissionState,
      requestPermission: async () => {
        asked = true;
        return "granted" as PermissionState;
      },
    };
    expect(await ensureWritePermission(handle)).toBe(true);
    expect(asked).toBe(false);
  });

  it("asks the browser when the answer is only a promise of one", async () => {
    const handle = {
      ...fakeDir("Kesonode"),
      queryPermission: async () => "prompt" as PermissionState,
      requestPermission: async () => "granted" as PermissionState,
    };
    expect(await ensureWritePermission(handle)).toBe(true);
  });

  it("refuses when the user says no", async () => {
    const handle = {
      ...fakeDir("Kesonode"),
      queryPermission: async () => "denied" as PermissionState,
    };
    expect(await ensureWritePermission(handle)).toBe(false);
  });

  it("refuses when the browser throws", async () => {
    const handle = {
      ...fakeDir("Kesonode"),
      queryPermission: async () => {
        throw new Error("no");
      },
    };
    expect(await ensureWritePermission(handle)).toBe(false);
  });
});

describe("remembering the folder", () => {
  it("keeps the folder between sessions", async () => {
    installFakeIndexedDb();
    await saveInstallFolder(fakeDir("Kesonode"));
    const loaded = await loadInstallFolder();
    expect(loaded?.name).toBe("Kesonode");
  });

  it("forgets it when the user unbinds it", async () => {
    installFakeIndexedDb();
    await saveInstallFolder(fakeDir("Kesonode"));
    await forgetInstallFolder();
    expect(await loadInstallFolder()).toBe(null);
  });

  it("reports no folder when the browser cannot store one", async () => {
    // A private window that refuses IndexedDB is not an error the user has to read.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    expect(await loadInstallFolder()).toBe(null);
    await expect(forgetInstallFolder()).resolves.toBeUndefined();
  });

  it("reports no folder when what came back is not a folder", async () => {
    installFakeIndexedDb();
    await saveInstallFolder({ kind: "file", name: "x" } as unknown as DirectoryHandleLike);
    expect(await loadInstallFolder()).toBe(null);
  });
});
