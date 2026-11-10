// package.json is the single source of truth for the version. This script stamps it
// into public/manifest.json and every locale's extension_name, so a release changes
// ONE number in ONE place.
//
// Stamping is IDEMPOTENT and never changes the version. That matters because build,
// build:firefox, package:source and package:source:pinned each call this script, and
// the old implementation bumped the patch on EVERY call. One "release" therefore
// produced several different versions depending on which commands were run, and the
// zip filename (read from package.json) could disagree with the manifest copied out
// of a stale dist/. v1.5.5 shipped as a 1.5.5-named zip carrying a 1.5.4 manifest —
// which is also why fixes made in source appeared not to reach the installed build.
//
// Bumping is now an explicit, deliberate act:
//   npm run version:patch   (or: node scripts/sync-version.mjs --bump)
//   npm run version:minor
//   npm run version:major
// A bump also repairs package-lock.json, whose root version had drifted to 1.5.2.
//
// Usage: node scripts/sync-version.mjs [--bump|--patch|--minor|--major]

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");
const lockPath = resolve(root, "package-lock.json");

const args = process.argv.slice(2);
const part = args.includes("--major") ? "major"
  : args.includes("--minor") ? "minor"
  : args.includes("--bump") || args.includes("--patch") ? "patch"
  : null;

let pkgRaw = readFileSync(pkgPath, "utf8");
let version = pkgRaw.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
if (!version) throw new Error("package.json has no version field.");
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!parsed) throw new Error(`Unsupported version "${version}" — expected X.Y.Z.`);

if (part) {
  const [maj, min, pat] = parsed.slice(1).map(Number);
  const next = part === "major" ? `${maj + 1}.0.0`
    : part === "minor" ? `${maj}.${min + 1}.0`
    : `${maj}.${min}.${pat + 1}`;
  // Replace only the FIRST "version" (the top-level one), preserving all formatting.
  pkgRaw = pkgRaw.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`);
  writeFileSync(pkgPath, pkgRaw);
  version = next;
  console.log(`package.json version -> ${version}`);

  // npm writes the root version twice into the lockfile. Leaving it alone is how
  // package-lock.json stayed at 1.5.2 while package.json said 1.5.5.
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.version !== version || lock.packages?.[""]?.version !== version) {
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
      console.log(`package-lock.json version -> ${version}`);
    }
  }
}

// 1) manifest "version"
const manifestPath = resolve(root, "public/manifest.json");
const raw = readFileSync(manifestPath, "utf8");
const updated = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (updated !== raw) {
  writeFileSync(manifestPath, updated);
  console.log(`public/manifest.json version -> ${version}`);
} else {
  console.log(`public/manifest.json version already ${version}`);
}

// 2) extension display name carries the version too, so several Kesonode copies loaded
//    from different folders are tellable apart in the browser's extension list (which only
//    shows the name, not the version). Idempotent: strips any earlier " vX.Y.Z" suffix
//    first, so repeated builds don't stack versions.
const nameSuffix = ` v${version}`;
const localesDir = resolve(root, "public/_locales");
if (existsSync(localesDir)) {
  let stamped = 0;
  for (const lang of readdirSync(localesDir)) {
    const p = resolve(localesDir, lang, "messages.json");
    if (!existsSync(p)) continue;
    const msgs = JSON.parse(readFileSync(p, "utf8"));
    if (!msgs.extension_name?.message) continue;
    const cleaned = msgs.extension_name.message.replace(/\s+v\d+\.\d+\.\d+$/, "");
    const next = cleaned + nameSuffix;
    if (next === msgs.extension_name.message) continue;
    msgs.extension_name.message = next;
    writeFileSync(p, JSON.stringify(msgs, null, 2) + "\n");
    stamped++;
  }
  console.log(`extension_name + ${nameSuffix} (${stamped} locales changed)`);
}

console.log(
  `Version ${version} stamped. No automatic bump — use npm run version:patch for a new release.`,
);
