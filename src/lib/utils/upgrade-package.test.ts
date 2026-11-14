import { describe, it, expect } from "vitest";
import {
  compareVersions,
  extractPackage,
  inspectUpgradePackage,
  type PackageFile,
} from "@/lib/utils/upgrade-package";

const enc = new TextEncoder();
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

interface ZipFile {
  name: string;
  /** Bytes exactly as they appear in the archive (already deflated when method is 8). */
  data: Uint8Array;
  method?: number;
  rawSize?: number;
}

/** Build a minimal, valid zip. Real release zips are deflated; stored entries keep most
 *  of these tests independent of the platform's stream APIs. */
function buildZip(files: ZipFile[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const method = file.method ?? 0;
    const rawSize = file.rawSize ?? file.data.length;

    const local = new Uint8Array(30 + name.length + file.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(10, method, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, rawSize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, rawSize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + eocd.length);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function asFile(bytes: Uint8Array): PackageFile {
  return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
}

function chromiumManifest(version: string): string {
  return JSON.stringify({
    manifest_version: 3,
    version,
    background: { service_worker: "background.js", type: "module" },
  });
}

function firefoxManifest(version: string): string {
  return JSON.stringify({
    manifest_version: 3,
    version,
    browser_specific_settings: { gecko: { id: "kesonode@proton.me" } },
    background: { scripts: ["background.js"], type: "module" },
  });
}

function releaseZip(version: string, manifest = chromiumManifest(version)): Uint8Array {
  return buildZip([
    { name: "manifest.json", data: enc.encode(manifest) },
    { name: "popup.html", data: enc.encode("<html></html>") },
    { name: "chunks/", data: new Uint8Array(0) },
    { name: "chunks/index-abc.js", data: enc.encode("// chunk") },
  ]);
}

const CHROMIUM = { currentVersion: "1.5.18", currentTarget: "chromium" as const };

describe("compareVersions", () => {
  it("orders dotted numeric versions by segment, not as strings", () => {
    expect(compareVersions("1.5.19", "1.5.18")).toBe(1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.5.18", "1.5.18")).toBe(0);
    expect(compareVersions("1.5.9", "1.5.10")).toBe(-1);
  });

  it("accepts a leading v from a GitHub tag and never treats junk as newer", () => {
    expect(compareVersions("v1.5.19", "1.5.18")).toBe(1);
    expect(compareVersions("beta", "1.5.18")).toBe(-1);
  });
});

describe("inspectUpgradePackage", () => {
  it("accepts a genuine, newer Chromium package", async () => {
    const result = await inspectUpgradePackage(asFile(releaseZip("1.5.19")), CHROMIUM);
    expect(result).toEqual({ ok: true, version: "1.5.19", target: "chromium", entries: 4 });
  });

  it("accepts the ./ prefix some zip tools put in front of entry names", async () => {
    const bytes = buildZip([
      { name: "./manifest.json", data: enc.encode(chromiumManifest("1.5.19")) },
      { name: "./popup.html", data: enc.encode("<html></html>") },
    ]);
    expect((await inspectUpgradePackage(asFile(bytes), CHROMIUM)).ok).toBe(true);
  });

  it("reads a deflated manifest, which is how release zips are actually built", async () => {
    const raw = enc.encode(chromiumManifest("1.5.19"));
    const copy = new Uint8Array(raw.length);
    copy.set(raw);
    const compressed = new Uint8Array(
      await new Response(
        new Blob([copy.buffer]).stream().pipeThrough(new CompressionStream("deflate-raw"))
      ).arrayBuffer()
    );
    const bytes = buildZip([
      { name: "manifest.json", data: compressed, method: 8, rawSize: raw.length },
      { name: "popup.html", data: enc.encode("<html></html>") },
    ]);
    expect(await inspectUpgradePackage(asFile(bytes), CHROMIUM)).toMatchObject({
      ok: true,
      version: "1.5.19",
    });
  });

  it("refuses the same version or an older one", async () => {
    for (const version of ["1.5.18", "1.5.17"]) {
      expect(await inspectUpgradePackage(asFile(releaseZip(version)), CHROMIUM)).toEqual({
        ok: false,
        reason: "version",
      });
    }
  });

  it("refuses a package built for the other browser", async () => {
    const bytes = releaseZip("1.5.19", firefoxManifest("1.5.19"));
    expect(await inspectUpgradePackage(asFile(bytes), CHROMIUM)).toEqual({
      ok: false,
      reason: "browser",
    });
  });

  it("accepts a Firefox package when running in Firefox", async () => {
    const bytes = releaseZip("1.5.19", firefoxManifest("1.5.19"));
    const result = await inspectUpgradePackage(asFile(bytes), {
      currentVersion: "1.5.18",
      currentTarget: "firefox",
    });
    expect(result).toMatchObject({ ok: true, target: "firefox" });
  });

  it("skips the browser check only when the running browser cannot be identified", async () => {
    const bytes = releaseZip("1.5.19", firefoxManifest("1.5.19"));
    expect(
      (await inspectUpgradePackage(asFile(bytes), {
        currentVersion: "1.5.18",
        currentTarget: "unknown",
      })).ok
    ).toBe(true);
  });

  it("refuses an archive without a root manifest or any HTML entry", async () => {
    const noManifest = buildZip([{ name: "popup.html", data: enc.encode("<html></html>") }]);
    const noHtml = buildZip([{ name: "manifest.json", data: enc.encode(chromiumManifest("1.5.19")) }]);
    for (const bytes of [noManifest, noHtml]) {
      expect(await inspectUpgradePackage(asFile(bytes), CHROMIUM)).toEqual({
        ok: false,
        reason: "zip",
      });
    }
  });

  it("refuses a manifest that is not MV3 or has no usable version", async () => {
    const mv2 = JSON.stringify({ manifest_version: 2, version: "1.5.19", background: { service_worker: "x.js" } });
    const noVersion = JSON.stringify({ manifest_version: 3, background: { service_worker: "x.js" } });
    for (const manifest of [mv2, noVersion]) {
      expect(await inspectUpgradePackage(asFile(releaseZip("1.5.19", manifest)), CHROMIUM)).toEqual({
        ok: false,
        reason: "zip",
      });
    }
  });

  it("refuses path traversal, absolute paths and Windows drive letters", async () => {
    for (const name of ["../evil.js", "chunks/../../evil.js", "/etc/passwd", "C:/evil.js", "a\\..\\evil.js"]) {
      const bytes = buildZip([
        { name: "manifest.json", data: enc.encode(chromiumManifest("1.5.19")) },
        { name: "popup.html", data: enc.encode("<html></html>") },
        { name, data: enc.encode("bad") },
      ]);
      expect(await inspectUpgradePackage(asFile(bytes), CHROMIUM)).toEqual({
        ok: false,
        reason: "unsafe",
      });
    }
  });

  it("refuses a file that is not a zip, a truncated zip, and an oversized file", async () => {
    const junk = enc.encode("this is not a zip");
    const truncated = releaseZip("1.5.19").subarray(0, 40);
    expect(await inspectUpgradePackage(asFile(junk), CHROMIUM)).toEqual({ ok: false, reason: "zip" });
    expect(await inspectUpgradePackage(asFile(truncated), CHROMIUM)).toEqual({ ok: false, reason: "zip" });
    const huge: PackageFile = {
      size: 33 * 1024 * 1024,
      arrayBuffer: async () => { throw new Error("must not be read"); },
    };
    expect(await inspectUpgradePackage(huge, CHROMIUM)).toEqual({ ok: false, reason: "zip" });
  });
});

describe("extractPackage", () => {
  it("reads a flat package, the layout the Chrome Web Store requires", async () => {
    const result = await extractPackage(asFile(releaseZip("1.5.19")), CHROMIUM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.version).toBe("1.5.19");
    expect(result.package.target).toBe("chromium");
    // The store package pins no key, so the ID would follow the folder name.
    expect(result.package.manifestKey).toBe(null);
    // The folder entry carries no data and is not part of the package.
    expect(result.package.entries.map((e) => e.path).sort()).toEqual([
      "chunks/index-abc.js",
      "manifest.json",
      "popup.html",
    ]);
  });

  it("reads the source layout, where everything sits inside one folder", async () => {
    const bytes = buildZip([
      { name: "Kesonode/manifest.json", data: enc.encode(chromiumManifest("1.5.19")) },
      { name: "Kesonode/popup.html", data: enc.encode("<html></html>") },
      { name: "Kesonode/chunks/app.js", data: enc.encode("// chunk") },
    ]);
    const result = await extractPackage(asFile(bytes), CHROMIUM);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The folder name is packaging, not content: what is written goes where it belongs.
    expect(result.package.entries.map((e) => e.path).sort()).toEqual([
      "chunks/app.js",
      "manifest.json",
      "popup.html",
    ]);
  });

  it("carries the manifest key, because the key decides the extension ID", async () => {
    const manifest = JSON.stringify({
      manifest_version: 3,
      version: "1.5.19",
      key: "the-pinned-key",
      background: { service_worker: "background.js" },
    });
    const bytes = buildZip([
      { name: "manifest.json", data: enc.encode(manifest) },
      { name: "popup.html", data: enc.encode("<html></html>") },
    ]);
    const result = await extractPackage(asFile(bytes), CHROMIUM);
    expect(result.ok && result.package.manifestKey).toBe("the-pinned-key");
  });

  it("refuses exactly what the inspector refuses", async () => {
    expect(await extractPackage(asFile(releaseZip("1.5.18")), CHROMIUM)).toEqual({
      ok: false,
      reason: "version",
    });
    expect(await extractPackage(asFile(releaseZip("1.5.19", firefoxManifest("1.5.19"))), CHROMIUM)).toEqual({
      ok: false,
      reason: "browser",
    });
  });

  it("refuses a package whose paths try to leave the folder", async () => {
    const bytes = buildZip([
      { name: "manifest.json", data: enc.encode(chromiumManifest("1.5.19")) },
      { name: "popup.html", data: enc.encode("<html></html>") },
      { name: "../evil.js", data: enc.encode("bad") },
    ]);
    expect(await extractPackage(asFile(bytes), CHROMIUM)).toEqual({ ok: false, reason: "unsafe" });
  });

  it("refuses a folder layout with no manifest in it", async () => {
    const bytes = buildZip([
      { name: "Kesonode/popup.html", data: enc.encode("<html></html>") },
      { name: "Kesonode/chunks/app.js", data: enc.encode("// chunk") },
    ]);
    expect(await extractPackage(asFile(bytes), CHROMIUM)).toEqual({ ok: false, reason: "zip" });
  });
});
