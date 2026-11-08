import { describe, it, expect } from "vitest";
import {
  DATA_BACKUP_FORMAT,
  DATA_BACKUP_VERSION,
  buildDataBackup,
  readDataBackup,
} from "@/lib/utils/data-backup";
import { canonicalJson, withChecksum } from "@/lib/utils/checksum";

/**
 * Literal files from the layouts this importer has to keep reading. APPEND an entry
 * whenever a release changes the format; never edit an existing one.
 */
const HISTORICAL_FILES: { release: string; file: unknown }[] = [
  {
    release: "1.5.2 (wrapped layout, no format marker or checksum)",
    file: {
      version: "1.0",
      exportedAt: "2026-11-08T02:00:00.000Z",
      device: "Windows 10/11 · Chromium",
      data: {
        bookmarks: [{
          title: "root",
          children: [{ title: "Example", url: "https://example.com/" }],
        }],
        extensions: [],
        history: [{ url: "https://example.com/", title: "Example", lastVisitTime: 1, visitCount: 1 }],
      },
    },
  },
  {
    release: "older top-level layout",
    file: {
      version: "1.0",
      bookmarks: [{
        title: "root",
        children: [{ title: "Legacy", url: "https://legacy.example/" }],
      }],
      history: [{ url: "https://legacy.example/" }],
    },
  },
];

const sample = () => buildDataBackup({
  bookmarks: [{ title: "root", children: [] }],
  extensions: [],
  history: [],
}, "device");

describe("data backup compatibility", () => {
  for (const { release, file } of HISTORICAL_FILES) {
    it(`reads a literal file written by ${release}`, async () => {
      const payload = await readDataBackup(JSON.parse(JSON.stringify(file)));
      expect(payload.bookmarks).toHaveLength(1);
      expect(payload.bookmarks[0].children?.[0].url).toContain("example");
      expect(payload.history).toHaveLength(1);
    });
  }

  it("the current export has a stable envelope and is readable", async () => {
    const bundle = await sample();
    expect(Object.keys(bundle).sort()).toEqual(
      ["checksum", "data", "device", "exportedAt", "format", "version"]
    );
    expect(bundle.format).toBe(DATA_BACKUP_FORMAT);
    expect(bundle.version).toBe(DATA_BACKUP_VERSION);
    expect(bundle.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await readDataBackup(JSON.parse(JSON.stringify(bundle)))).bookmarks).toHaveLength(1);
  });

  it("refuses a future format version instead of guessing", async () => {
    const future = await sample();
    future.version = "2.0";
    await expect(readDataBackup(future)).rejects.toThrow(/newer Kesonode|Update Kesonode/);
  });

  it("refuses a wrong format marker, even with a valid version", async () => {
    await expect(readDataBackup({
      format: "kesonode-settings", version: DATA_BACKUP_VERSION, data: {},
    })).rejects.toThrow(/not a Kesonode data backup/);
    await expect(readDataBackup({
      format: "something-else", version: DATA_BACKUP_VERSION, data: {},
    })).rejects.toThrow();
  });

  it("refuses malformed or missing versions", async () => {
    for (const version of [undefined, null, "", 1, {}, "1.0.1"]) {
      const file: Record<string, unknown> = { version: "1.0", data: { bookmarks: [] } };
      file.version = version;
      await expect(readDataBackup(file)).rejects.toThrow();
    }
  });

  it("normalises damaged payloads into safe lists", async () => {
    const single = await readDataBackup({
      version: "1.0", bookmarks: { title: "root", children: [] },
    });
    expect(single.bookmarks).toHaveLength(1);

    const dirty = await readDataBackup({
      version: "1.0",
      data: {
        bookmarks: [null, "text", { title: "ok" }],
        history: [null, { url: "https://example.com/" }],
      },
    });
    expect(dirty.bookmarks).toHaveLength(1);
    expect(dirty.history).toHaveLength(1);

    await expect(readDataBackup({ version: "1.0", data: "not-an-object" })).rejects.toThrow();
  });

  it("refuses a file whose contents no longer match its checksum", async () => {
    const bundle = await sample();
    (bundle.data as Record<string, unknown>).bookmarks = [{ title: "tampered", children: [] }];
    await expect(readDataBackup(bundle)).rejects.toThrow(/checksum/i);
  });

  it("refuses a malformed checksum", async () => {
    const bundle = await sample();
    bundle.checksum = "not-a-hash";
    await expect(readDataBackup(bundle)).rejects.toThrow(/malformed checksum/i);
  });

  it("survives re-serialisation with a different key order", async () => {
    const bundle = await sample();
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(bundle).reverse()) reordered[key] = bundle[key];
    expect(canonicalJson(reordered)).toBe(canonicalJson(bundle));
    expect((await readDataBackup(reordered)).bookmarks).toHaveLength(1);
  });

  it("a checksum can be recomputed after editing: it is not an authentication code", async () => {
    const bundle = await sample();
    (bundle.data as Record<string, unknown>).bookmarks = [{ title: "edited", children: [] }];
    const edited = await withChecksum(bundle);
    expect(edited.checksum).not.toBe(bundle.checksum);
    expect((await readDataBackup(edited)).bookmarks[0].title).toBe("edited");
  });
});
