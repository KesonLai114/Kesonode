// Publish a GitHub release from the zips already committed under 插件版本/.
//
// WHY THIS EXISTS
// ---------------
// Packaging and publishing were two disconnected steps. `npm run package:source:pinned`
// built the zips and committed them to 插件版本/vX.Y.Z/, but nothing created the version
// tag — and a GitHub Release only exists once a `v*` tag is pushed (release.yml). So a
// release could be fully built, committed and pushed to main while the Releases page sat
// at an old version. That is the "why is there no latest zip, I have to remind you every
// time" problem. This script is the missing half: run it AFTER packaging+committing.
//
// It uses the COMMITTED zips, not a fresh build. Those are the exact bytes verified at
// packaging time (manifest version, pinned extension key, no secret) and byte-for-byte
// identical to the zips on past releases. Rebuilding here could attach a different
// artifact than the one that was checked. Tag push also triggers release.yml, whose
// create step is idempotent, so the two paths cannot conflict.
//
// IDEMPOTENT: re-running is safe. An existing tag pointing at HEAD is reused, an existing
// release is left untouched. Nothing is forced or overwritten.
//
// Usage:
//   npm run release                 # publish version from package.json
//   npm run release -- --dry-run    # print the plan, change nothing
//   npm run release -- --notes-file path.md   # use a hand-written body instead
//
// Requires: `gh` authenticated with repo scope, `git`, and a clean working tree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function run(args, opts = {}) {
  const { cwd = root, exec = execFileSync } = opts;
  const sh = (cmd, cmdArgs, io = {}) =>
    exec(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...io });

  const version = readFileSync(join(cwd, "package.json"), "utf8").match(
    /"version"\s*:\s*"(\d+\.\d+\.\d+)"/
  )?.[1];
  if (!version) throw new Error("package.json has no X.Y.Z version.");

  const tag = `v${version}`;
  const dir = join(cwd, "插件版本", tag);
  const zips = {
    chrome: join(dir, `kesonode-chrome-${version}.zip`),
    firefox: join(dir, `kesonode-firefox-${version}.zip`),
  };
  for (const [browser, p] of Object.entries(zips)) {
    if (!existsSync(p)) {
      throw new Error(`Missing ${browser} package: ${p}. Package and commit it first.`);
    }
  }

  const head = sh("git", ["rev-parse", "HEAD"]).trim();
  const dirty = sh("git", ["status", "--porcelain"]).trim();
  if (dirty) {
    throw new Error(`Working tree is not clean. Commit changes before releasing:\n${dirty}`);
  }

  const plan = { version, tag, head, zips };
  if (args.includes("--dry-run")) return { ...plan, dryRun: true };

  // Tag: create if absent, otherwise require it to point at HEAD.
  let tagHash = "";
  try {
    tagHash = sh("git", ["rev-parse", `refs/tags/${tag}`]).trim();
  } catch {
    // not present locally
  }
  if (tagHash && tagHash !== head) {
    throw new Error(`Tag ${tag} points at ${tagHash}, not HEAD ${head}. Re-tag on the release commit.`);
  }
  if (!tagHash) sh("git", ["tag", tag]);
  sh("git", ["push", "origin", tag]);

  // Release: only create when absent. Keep an existing release's assets as-is.
  let releaseExists = false;
  try {
    sh("gh", ["release", "view", tag, "--json", "tagName"]);
    releaseExists = true;
  } catch {
    // gh release view exits non-zero when the release does not exist
  }

  const notesFile = args.includes("--notes-file")
    ? resolve(cwd, args[args.indexOf("--notes-file") + 1])
    : null;
  let tmpNotes = null;
  try {
    if (!releaseExists) {
      let notesArgs;
      if (notesFile) {
        if (!existsSync(notesFile)) throw new Error(`Notes file not found: ${notesFile}`);
        notesArgs = ["--notes-file", notesFile];
      } else {
        const body = composeNotes(cwd, version);
        if (body) {
          tmpNotes = mkdtempSync(join(tmpdir(), "kesonode-release-"));
          const p = join(tmpNotes, "body.md");
          writeFileSync(p, body);
          notesArgs = ["--notes-file", p];
        } else {
          notesArgs = ["--generate-notes"];
        }
      }
      sh("gh", [
        "release", "create", tag,
        zips.chrome, zips.firefox,
        "--title", `Kesonode ${tag}`,
        ...notesArgs,
      ]);
    }
  } finally {
    if (tmpNotes) rmSync(tmpNotes, { recursive: true, force: true });
  }

  return { ...plan, dryRun: false, releaseExists };
}

/**
 * Build a release body from the CHANGELOG section for `version`, plus the standard
 * download/Drive caveat. Returns null when there is no matching section, so the caller
 * falls back to --generate-notes. Pure enough to unit-test.
 */
export function composeNotes(cwd, version) {
  const changelogPath = join(cwd, "CHANGELOG.md");
  if (!existsSync(changelogPath)) return null;
  const changelog = readFileSync(changelogPath, "utf8");
  const heading = new RegExp(`^## \\[${
    version.replace(/\./g, "\\.")
  }\\][^\\n]*$`, "m");
  const m = heading.exec(changelog);
  if (!m) return null;

  const afterHeading = changelog.slice(m.index + m[0].length);
  const next = afterHeading.search(/^## \[/m);
  const section = (next < 0 ? afterHeading : afterHeading.slice(0, next)).trim();
  if (!section) return null;

  return [
    `Kesonode v${version}`,
    "",
    "安装包：",
    "",
    `- \`kesonode-chrome-${version}.zip\` — Chrome / Edge / Brave 等 Chromium 浏览器`,
    `- \`kesonode-firefox-${version}.zip\` — Firefox 系浏览器`,
    "",
    "两个包均为 source 构建，不含内置 Google OAuth 密钥：GitHub / WebDAV 开箱即用，Google Drive 需自行创建 OAuth 客户端。压缩包解压后是一个固定名为 `Kesonode` 的文件夹（名字不带版本号），升级时始终复用同一文件夹——这是一键升级能成立的前提。",
    "",
    "---",
    "",
    "## 变更记录",
    "",
    `> 摘自仓库 \`CHANGELOG.md\` 的 ${version} 章节。`,
    "",
    section,
    "",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  try {
    const result = run(args);
    if (result.dryRun) {
      console.log(`[dry-run] Would publish ${result.tag} from HEAD ${result.head.slice(0, 8)}`);
      console.log(`[dry-run]   ${result.zips.chrome}`);
      console.log(`[dry-run]   ${result.zips.firefox}`);
      console.log("[dry-run] No tag, push or release was made.");
      return;
    }
    console.log(`Release ${result.tag}: ${result.releaseExists ? "already existed, left untouched" : "created"}.`);
    console.log("Next: edit the release body on GitHub if needed (which download, Drive caveat, upgrade note).");
  } catch (err) {
    console.error(`release failed: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
