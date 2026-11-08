import { describe, it, expect, afterEach, vi } from "vitest";
import { SyncEngine } from "@/lib/sync/sync-engine";
import { WebDAVBackend } from "@/lib/backends/webdav-backend";
import { GDriveBackend } from "@/lib/backends/gdrive-backend";
import { DEFAULT_SETTINGS, KEYS } from "@/lib/utils/storage";
import type { BackendConfig, SyncSettings } from "@/lib/types";
import {
  ISOLATED_FILE_PREFIX,
  KESONODE_FOLDER,
  UPSTREAM_PROTOCOL,
  driveFolderName,
  driveFolderNameFor,
  folderPath,
  folderPathFor,
  getCompatMode,
  isPeerFileName,
  listPrefixes,
  readPrefixes,
  resetCompatMode,
  setCompatMode,
  writePrefix,
} from "./protocol";

// Three modes, ONE place that decides the folder name: backends, the upload destination
// tag and the Settings page must all agree. A mismatch here is the old "sync says OK but
// the new folder stays empty" bug: uploadIfChanged sees an unchanged destination tag and
// skips the upload into the folder the backend now writes to.

const webdav: BackendConfig = {
  type: "webdav", label: "WebDAV", enabled: true,
  webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
};

function settings(mode: SyncSettings["compat_mode"]): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "dev-1",
    compat_mode: mode,
    active_backend: "webdav",
    backends: [webdav],
  };
}

afterEach(() => {
  resetCompatMode();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the three compatibility modes", () => {
  it("leaves the upstream contract byte-for-byte frozen and adds a separate pair", () => {
    expect(UPSTREAM_PROTOCOL).toMatchObject({
      driveFolderName: "Konode",
      defaultBackendPath: "konode",
      packetFilePrefix: "konode_",
    });
    expect(KESONODE_FOLDER).toEqual({
      driveFolderName: "Kesonode",
      defaultBackendPath: "kesonode",
    });
  });

  it("defaults to the upstream folder, and only standalone picks Kesonode's", () => {
    expect(folderPathFor(undefined)).toBe("konode");
    expect(folderPathFor("upstream")).toBe("konode");
    expect(folderPathFor("isolated")).toBe("konode");
    expect(folderPathFor("standalone")).toBe("kesonode");
    expect(driveFolderNameFor(undefined)).toBe("Konode");
    expect(driveFolderNameFor("isolated")).toBe("Konode");
    expect(driveFolderNameFor("standalone")).toBe("Kesonode");
  });

  it("the pure helpers and the worker's live mode never disagree", () => {
    for (const mode of ["upstream", "isolated", "standalone"] as const) {
      setCompatMode(mode);
      expect(getCompatMode()).toBe(mode);
      expect(folderPath()).toBe(folderPathFor(mode));
      expect(driveFolderName()).toBe(driveFolderNameFor(mode));
    }
  });

  it("standalone reads only its own files: no double-read of the upstream namespace", () => {
    setCompatMode("standalone");
    expect(writePrefix()).toBe(ISOLATED_FILE_PREFIX);
    expect(readPrefixes()).toEqual(["kesonode_"]);
    expect(listPrefixes("bookmarks")).toEqual(["kesonode_bookmarks_"]);
    expect(isPeerFileName("konode_bookmarks_other.json", "bookmarks")).toBe(false);
    expect(isPeerFileName("kesonode_bookmarks_other.json", "bookmarks")).toBe(true);
  });

  it("isolated still reads both prefixes, as it always did", () => {
    setCompatMode("isolated");
    expect(writePrefix()).toBe("kesonode_");
    expect(readPrefixes()).toEqual(["kesonode_", "konode_"]);
  });
});

describe("backends write into the folder the mode names", () => {
  it("WebDAV MKCOLs the standalone folder, not the upstream one", async () => {
    const mkcol: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
      if (init?.method === "MKCOL") mkcol.push(url);
      return Promise.resolve({
        ok: true, status: 201, redirected: false, text: () => Promise.resolve(""),
      } as Response);
    });
    setCompatMode("standalone");
    await new WebDAVBackend(webdav).connect();
    expect(mkcol[0]).toBe("https://dav.example.com/dav/kesonode");
  });

  it("Drive looks up and creates the standalone folder name", async () => {
    await chrome.storage.local.set({
      [KEYS.GDRIVE_SESSION]: {
        access_token: "test-token", expires_at: Date.now() + 3_600_000,
        email: "a@b.c", displayName: "Tester", savedAt: Date.now(),
      },
    });
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(init?.method === "POST" ? { id: "new-folder" } : { files: [] }),
      } as Response);
    });
    setCompatMode("standalone");
    await new GDriveBackend({ type: "gdrive", label: "Google Drive", enabled: true, gdrive: {} }).connect();

    const lookups = calls.filter((c) => c.method !== "POST");
    expect(lookups.length).toBeGreaterThan(0);
    expect(decodeURIComponent(lookups[0].url)).toContain("name='Kesonode'");
    expect(calls.some((c) => c.method === "POST" && JSON.parse(c.body ?? "{}").name === "Kesonode")).toBe(true);
  });
});

describe("switching mode cannot skip an upload", () => {
  const privateOf = (mode: SyncSettings["compat_mode"]) => {
    const engine = new SyncEngine(settings(mode), () => {}) as unknown as {
      destinationTag(): string;
      uploadTag(checksum: string, useE2ee: boolean): string;
    };
    return engine;
  };

  it("the destination tag follows the folder", () => {
    expect(privateOf("upstream").destinationTag()).toContain("/konode");
    expect(privateOf("standalone").destinationTag()).toContain("/kesonode");
    expect(privateOf("isolated").destinationTag()).toBe(privateOf("upstream").destinationTag());
  });

  it("all three upload tags differ, so every switch re-uploads once", () => {
    const tags = (["upstream", "isolated", "standalone"] as const)
      .map((m) => privateOf(m).uploadTag("same-checksum", false));
    expect(new Set(tags).size).toBe(3);
  });
});
