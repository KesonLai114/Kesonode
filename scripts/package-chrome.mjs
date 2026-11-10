// Zip the built dist/ into a Chrome Web Store upload package.
//
// Run after `npm run build`. Produces web-ext-artifacts/kesonode-chrome-<version>.zip
// with manifest.json at the archive root (what the Web Store expects).
//
// The manifest `key` pins the extension ID of an unpacked install. It's kept in
// public/manifest.json (and thus dist/) for `chrome://extensions` dev loading, but the
// Chrome Web Store rejects a first upload whose manifest contains `key` ("key field not
// allowed in manifest"), so STORE packages always strip it.
//
// Unpacked installs loaded from a version folder need it. Without `key`, Chrome derives the
// ID from the folder path, so every new version is a NEW extension with an empty
// chrome.storage.local and the user has to set the backend up all over again. Packages
// built with `--keep-key` (npm run package:source:pinned) leave it in place and the ID
// stays the same wherever the folder lives. 1.5.2 deliberately shipped WITHOUT the key:
// that release added settings export/import and had to be loaded over the old folder so
// the old settings were still readable when they were exported. From 1.5.3 on, use the
// pinned package.
//
// After the store assigns the published extension ID (Package tab), add
// https://<published-id>.chromiumapp.org/gdrive to the Google OAuth client's
// authorized redirect URIs, or Drive sign-in breaks for published users. See
// STORE_LISTING.md.
//
// Usage: node scripts/package-chrome.mjs [--variant=store|source]
//   `npm run package:chrome` builds and packages the STORE variant;
//   `npm run package:source` does both browsers as SOURCE builds.
//
// The variant decides which folder the zip lands in, and it is checked against the built
// bundle before anything is written. See build-variant.mjs for why that check exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, cpSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pruneUnshippedLocales } from "./prune-locales.mjs";
import { variantFromArgv, assertVariant, assertVersion, assertBundleComplete, artifactDir } from "./build-variant.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distDir = resolve(repoRoot, "dist");

if (!existsSync(resolve(distDir, "manifest.json"))) {
  console.error("dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}

const variant = variantFromArgv();
assertVariant(distDir, variant);
// The zip NAME comes from package.json but its manifest is copied out of dist/.
// Refuse to write a package whose name and content disagree, or whose HTML points
// at chunks from another build (see build-variant.mjs for both failure modes).
const version = assertVersion(repoRoot, distDir);
assertBundleComplete(distDir);
// A store upload must never carry a key, even if the flag was passed by mistake.
const keepKey = variant !== "store" && process.argv.includes("--keep-key");

const artifactsDir = resolve(repoRoot, "web-ext-artifacts", artifactDir("chrome", variant));

const outPath = resolve(artifactsDir, `kesonode-chrome-${version}.zip`);

mkdirSync(artifactsDir, { recursive: true });
rmSync(outPath, { force: true }); // zip appends otherwise

// On Windows, resolve bsdtar by absolute path: a `tar` on PATH there is usually
// GNU tar from Git for Windows, which can't write zip at all.
function bsdtar() {
  return process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

// Stage a copy so we can strip `key` without mutating dist/ (the dev-load dir).
const staging = mkdtempSync(join(tmpdir(), "kesonode-chrome-"));
try {
  cpSync(distDir, staging, { recursive: true });

  const manifestPath = join(staging, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!keepKey && "key" in manifest) {
    delete manifest.key;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Stripped \`key\` (${variant === "store" ? "store upload" : "migration source"}; kept in dist/ for dev).`);
  } else if ("key" in manifest) {
    console.log("Kept `key` — unpacked installs of this package share a stable extension ID.");
  }

  pruneUnshippedLocales(join(staging, "_locales"), manifest.default_locale);

  // Zip the CONTENTS of the staging dir (cwd: staging) so manifest.json lands at
  // the archive root. -r recurse, -X strip extra file attributes, exclude junk.
  try {
    execFileSync(
      "zip",
      ["-r", "-X", outPath, ".", "-x", "*.DS_Store", "-x", "__MACOSX/*"],
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
      ["-a", "-c", "-f", outPath, "--exclude", ".DS_Store", "--exclude", "__MACOSX", ...readdirSync(staging)],
      { cwd: staging, stdio: "inherit" }
    );
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(
  `\n${variant === "store" ? "STORE" : "SOURCE"} package (Chrome) written → ${outPath}`
);
console.log(
  variant === "store"
    ? "  ↑ this is the one that goes to the Chrome Web Store."
    : keepKey
    ? "  ↑ stable extension ID: unpacked upgrades keep their settings."
    : "  ↑ no pinned ID (1.5.2 migration release): load this over the previous folder."
);
