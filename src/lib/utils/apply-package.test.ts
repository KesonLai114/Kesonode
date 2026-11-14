import { describe, it, expect } from "vitest";
import { applyPackageToFolder, BACKUP_DIR } from "@/lib/utils/apply-package";
import type { DirectoryHandleLike, FileHandleLike } from "@/lib/utils/install-dir";
import type { ExtractedPackage } from "@/lib/utils/upgrade-package";

/**
 * An install folder in memory.
 *
 * The upgrade writes into the very folder the browser loads the extension from, so the
 * things worth testing are about what ends up IN that folder: the manifest arrives
 * last, the chunks of the previous release are gone, and the previous version is kept
 * somewhere it can be found again.
 */
class MemFile implements FileHandleLike {
  readonly kind = "file" as const;
  /** Set when the file is one the test wants to refuse to write. */
  fail = false;

  constructor(
    readonly name: string,
    public data: Uint8Array,
    private readonly log?: string[]
  ) {}

  async getFile() {
    const copy = this.data;
    return {
      text: async () => new TextDecoder().decode(copy),
      arrayBuffer: async () => copy.slice().buffer as ArrayBuffer,
    };
  }

  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: Uint8Array | ArrayBuffer | string) => {
        if (this.fail) throw new Error(`cannot write ${this.name}`);
        chunks.push(
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : data instanceof Uint8Array
              ? data
              : new Uint8Array(data)
        );
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.length;
        }
        this.data = out;
        this.log?.push(this.name);
      },
    };
  }
}

class MemDir implements DirectoryHandleLike {
  readonly kind = "directory" as const;
  readonly children = new Map<string, MemFile | MemDir>();
  /** File names in this folder that refuse to be written. */
  readonly failWrites = new Set<string>();

  constructor(
    readonly name: string,
    private readonly log?: string[]
  ) {}

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    const found = this.children.get(name);
    if (found instanceof MemFile) return found;
    if (found instanceof MemDir) throw new DOMException("not a file", "TypeMismatchError");
    if (!options?.create) throw new DOMException("no such file", "NotFoundError");
    const file = new MemFile(name, new Uint8Array(0), this.log);
    file.fail = this.failWrites.has(name);
    this.children.set(name, file);
    return file;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike> {
    const found = this.children.get(name);
    if (found instanceof MemDir) return found;
    if (!options?.create) throw new DOMException("no such folder", "NotFoundError");
    const dir = new MemDir(name, this.log);
    this.children.set(name, dir);
    return dir;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new DOMException("no such entry", "NotFoundError");
  }

  async *entries(): AsyncIterableIterator<[string, FileHandleLike | DirectoryHandleLike]> {
    for (const [key, value] of this.children) {
      yield [key, value] as [string, FileHandleLike | DirectoryHandleLike];
    }
  }

  async *values(): AsyncIterableIterator<FileHandleLike | DirectoryHandleLike> {
    for (const value of this.children.values()) yield value;
  }
}

const enc = new TextEncoder();

function manifest(version: string, key?: string): Uint8Array {
  return enc.encode(
    JSON.stringify({
      manifest_version: 3,
      version,
      ...(key ? { key } : {}),
      background: { service_worker: "background.js" },
    })
  );
}

/** An install folder that already holds a version of Kesonode. */
function installed(version: string, key?: string): { dir: MemDir; log: string[] } {
  const log: string[] = [];
  const dir = new MemDir("Kesonode", log);
  dir.children.set("manifest.json", new MemFile("manifest.json", manifest(version, key), log));
  dir.children.set("popup.html", new MemFile("popup.html", enc.encode("<html>old</html>"), log));
  const chunks = new MemDir("chunks", log);
  chunks.children.set("old-abc.js", new MemFile("old-abc.js", enc.encode("// old"), log));
  dir.children.set("chunks", chunks);
  return { dir, log };
}

function packageOf(
  version: string,
  key: string | null,
  entries: { path: string; bytes: Uint8Array }[]
): ExtractedPackage {
  return { version, target: "chromium", manifestKey: key, entries };
}

/** A package with the same shape as a real release. */
function release(version: string, key: string | null): ExtractedPackage {
  return packageOf(version, key, [
    { path: "manifest.json", bytes: manifest(version, key ?? undefined) },
    { path: "popup.html", bytes: enc.encode("<html>new</html>") },
    { path: "chunks/new-def.js", bytes: enc.encode("// new") },
  ]);
}

function textOf(dir: MemDir, path: string): string | null {
  const parts = path.split("/");
  const name = parts.pop() as string;
  let current = dir;
  for (const segment of parts) {
    const next = current.children.get(segment);
    if (!(next instanceof MemDir)) return null;
    current = next;
  }
  const file = current.children.get(name);
  if (!(file instanceof MemFile)) return null;
  return new TextDecoder().decode(file.data);
}

describe("applyPackageToFolder", () => {
  it("writes the new version over the old one and keeps the old one in a backup", async () => {
    const { dir } = installed("1.5.18", "the-key");
    const outcome = await applyPackageToFolder(dir, release("1.5.19", "the-key"));

    expect(outcome.ok).toBe(true);
    expect(outcome.previousVersion).toBe("1.5.18");
    expect(outcome.version).toBe("1.5.19");
    expect(outcome.written).toBe(3);
    expect(outcome.backup).toBe(`${BACKUP_DIR}/1.5.18`);
    expect(textOf(dir, "manifest.json")).toContain('"1.5.19"');
    expect(textOf(dir, "chunks/new-def.js")).toBe("// new");
    expect(textOf(dir, `${BACKUP_DIR}/1.5.18/manifest.json`)).toContain('"1.5.18"');
    expect(textOf(dir, `${BACKUP_DIR}/1.5.18/chunks/old-abc.js`)).toBe("// old");
  });

  it("removes the chunks the new version does not have", async () => {
    const { dir } = installed("1.5.18", "the-key");
    await applyPackageToFolder(dir, release("1.5.19", "the-key"));
    const chunks = dir.children.get("chunks");
    expect(chunks instanceof MemDir && chunks.children.has("old-abc.js")).toBe(false);
    expect(chunks instanceof MemDir && chunks.children.has("new-def.js")).toBe(true);
  });

  it("writes the manifest last, so a reload in between never sees a manifest without its code", async () => {
    const { dir, log } = installed("1.5.18", "the-key");
    await applyPackageToFolder(dir, release("1.5.19", "the-key"));
    expect(log[log.length - 1]).toBe("manifest.json");
    expect(log.lastIndexOf("new-def.js")).toBeLessThan(log.length - 1);
  });

  it("refuses a folder that holds no Kesonode, and writes nothing", async () => {
    const dir = new MemDir("Downloads");
    dir.children.set("notes.txt", new MemFile("notes.txt", enc.encode("hello")));
    const outcome = await applyPackageToFolder(dir, release("1.5.19", "the-key"));
    expect(outcome).toMatchObject({ ok: false, failure: "not_installed", written: 0 });
    expect(dir.children.has("notes.txt")).toBe(true);
    expect(dir.children.has("manifest.json")).toBe(false);
  });

  it("refuses a package that would change the extension ID", async () => {
    const { dir } = installed("1.5.18", "the-key");
    const outcome = await applyPackageToFolder(dir, release("1.5.19", null));
    expect(outcome).toMatchObject({ ok: false, failure: "key_mismatch", written: 0 });
    // Nothing was touched: the ID decides where every setting lives.
    expect(textOf(dir, "manifest.json")).toContain('"1.5.18"');
    expect(dir.children.has(BACKUP_DIR)).toBe(false);
  });

  it("refuses a package that adds an ID where the install has none", async () => {
    const { dir } = installed("1.5.18");
    const outcome = await applyPackageToFolder(dir, release("1.5.19", "the-key"));
    expect(outcome).toMatchObject({ ok: false, failure: "key_mismatch" });
  });

  it("accepts a package that pins no ID where the install pins none", async () => {
    const { dir } = installed("1.5.18");
    const outcome = await applyPackageToFolder(dir, release("1.5.19", null));
    expect(outcome.ok).toBe(true);
  });

  it("leaves the old version in place when a file cannot be written", async () => {
    const { dir } = installed("1.5.18", "the-key");
    const chunks = dir.children.get("chunks");
    if (!(chunks instanceof MemDir)) throw new Error("the fixture has no chunks folder");
    chunks.failWrites.add("new-def.js");

    const outcome = await applyPackageToFolder(dir, release("1.5.19", "the-key"));
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe("write");
    // The manifest is written last, so a failed write cannot have replaced it.
    expect(textOf(dir, "manifest.json")).toContain('"1.5.18"');
  });

  it("reads an installed manifest it cannot parse as a read failure, not a crash", async () => {
    const { dir } = installed("1.5.18", "the-key");
    const file = dir.children.get("manifest.json");
    if (!(file instanceof MemFile)) throw new Error("the fixture has no manifest");
    file.data = enc.encode("{ not json");
    const outcome = await applyPackageToFolder(dir, release("1.5.19", "the-key"));
    expect(outcome).toMatchObject({ ok: false, failure: "read", written: 0 });
  });
});
