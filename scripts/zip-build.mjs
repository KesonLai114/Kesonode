// Zip a built extension into a package.
//
// Two layouts, and the difference is not cosmetic:
//
//   flat   — manifest.json at the archive root. Both stores require it: the Chrome Web
//            Store rejects an upload whose manifest is one folder down.
//   folder — everything inside one folder named Kesonode. A release download has to
//            unpack into ONE folder, and that folder has to BE the install: the same
//            name every time, so an upgrade replaces the files in it instead of leaving
//            a pile of versioned folders for the user to choose between.
//
// The folder layout is what makes the one-click upgrade possible at all: the extension
// writes the new files into the folder it was loaded from, and that only works if there
// is one such folder and it never moves.
//
// The store layout stays flat forever: it is the stores' rule, not ours.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The name of the folder a release package unpacks into. Never changes. */
export const PACKAGE_FOLDER = "Kesonode";

export const LAYOUT_FLAT = "flat";
export const LAYOUT_FOLDER = "folder";

/**
 * On Windows, resolve bsdtar by absolute path: a `tar` on PATH there is usually GNU tar
 * from Git for Windows, which can't write zip at all.
 */
function bsdtar() {
  return process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

/**
 * Copy the build into a staging folder, let the caller change it, and zip it.
 *
 * The staging copy is what makes it safe to strip the manifest `key` from a package
 * without touching dist/ — the folder the developer loads unpacked.
 */
export function withStagedPackage({ buildDir, outPath, layout }, mutate) {
  const staging = mkdtempSync(join(tmpdir(), "kesonode-package-"));
  try {
    const packageDir = layout === LAYOUT_FOLDER ? join(staging, PACKAGE_FOLDER) : staging;
    cpSync(buildDir, packageDir, { recursive: true });
    if (mutate) mutate(packageDir);
    zipPackage(outPath, staging, layout);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function zipPackage(outPath, staging, layout) {
  const folder = layout === LAYOUT_FOLDER;
  // "." keeps the store layout exactly as it was: Info-ZIP drops the "./" itself.
  // A folder package names the folder, because that is what has to be in the archive.
  const entries = folder ? [PACKAGE_FOLDER] : ["."];
  try {
    execFileSync(
      "zip",
      ["-r", "-X", outPath, ...entries, "-x", "*.DS_Store", "-x", "__MACOSX/*"],
      { cwd: staging, stdio: "inherit" }
    );
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // No Info-ZIP `zip` (the normal case on Windows). bsdtar/libarchive ships with
    // Windows 10+ and writes zip via `-a`; pass the top-level entries rather than
    // "." so nothing gets a "./" prefix in the archive.
    console.log("`zip` not found, falling back to bsdtar.");
    execFileSync(
      bsdtar(),
      [
        "-a",
        "-c",
        "-f",
        outPath,
        "--exclude",
        ".DS_Store",
        "--exclude",
        "__MACOSX",
        ...(folder ? [PACKAGE_FOLDER] : readdirSync(staging)),
      ],
      { cwd: staging, stdio: "inherit" }
    );
  }
}
