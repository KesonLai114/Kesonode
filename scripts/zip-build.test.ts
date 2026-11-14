import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs build script, no types, imported for what it guards.
import { withStagedPackage, PACKAGE_FOLDER, LAYOUT_FLAT, LAYOUT_FOLDER } from "./zip-build.mjs";

// The layout of a release package is not a detail of the zip: it is what the user
// unpacks, what the upgrade script looks for, and what the extension writes over.
// A package that unpacks into loose files has to be turned into a folder by hand,
// and a package that unpacks into a folder with a version number in it leaves the
// user choosing between folders every time they upgrade.

const made: string[] = [];

/** A build directory, and a place next to it for the zip (never inside it). */
function build(): { buildDir: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "konode-zip-"));
  made.push(root);
  const buildDir = join(root, "dist");
  mkdirSync(join(buildDir, "chunks"), { recursive: true });
  writeFileSync(join(buildDir, "manifest.json"), JSON.stringify({ version: "1.5.20" }));
  writeFileSync(join(buildDir, "popup.html"), "<html></html>");
  writeFileSync(join(buildDir, "chunks", "index-abc.js"), "// chunk");
  return { buildDir, out: join(root, "package.zip") };
}

function zipEntries(path: string): string[] {
  try {
    return execFileSync("zip", ["-Z1", path], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return execFileSync("tar", ["-tf", path], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the package layout", () => {
  it("puts everything inside one folder for a release package", () => {
    const { buildDir, out } = build();
    withStagedPackage({ buildDir, outPath: out, layout: LAYOUT_FOLDER });

    const entries = zipEntries(out);
    expect(entries).toContain(`${PACKAGE_FOLDER}/manifest.json`);
    expect(entries).toContain(`${PACKAGE_FOLDER}/chunks/index-abc.js`);
    // The manifest must NOT also sit at the archive root: that is the store layout.
    expect(entries).not.toContain("manifest.json");
  });

  it("keeps the manifest at the archive root for a store package", () => {
    const { buildDir, out } = build();
    withStagedPackage({ buildDir, outPath: out, layout: LAYOUT_FLAT });

    const entries = zipEntries(out);
    expect(entries).toContain("manifest.json");
    expect(entries).not.toContain(`${PACKAGE_FOLDER}/manifest.json`);
  });

  it("lets the caller change the staged copy without touching the build", () => {
    const { buildDir, out } = build();
    withStagedPackage({ buildDir, outPath: out, layout: LAYOUT_FOLDER }, (packageDir) => {
      writeFileSync(join(packageDir, "manifest.json"), JSON.stringify({ version: "1.5.21" }));
    });

    expect(zipEntries(out)).toContain(`${PACKAGE_FOLDER}/manifest.json`);
    // The build itself is untouched — dist/ is the folder a developer loads unpacked.
    const kept = JSON.parse(readFileSync(join(buildDir, "manifest.json"), "utf8")) as { version: string };
    expect(kept.version).toBe("1.5.20");
  });
});
