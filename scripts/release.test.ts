import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs build script, no types, imported for what it guards.
import { run, composeNotes } from "./release.mjs";

const made: string[] = [];
function repo(version: string, changelog?: string): string {
  const root = mkdtempSync(join(tmpdir(), "kesonode-release-"));
  made.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  if (changelog) writeFileSync(join(root, "CHANGELOG.md"), changelog);
  const dir = join(root, "插件版本", `v${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `kesonode-chrome-${version}.zip`), "chrome-bytes");
  writeFileSync(join(dir, `kesonode-firefox-${version}.zip`), "firefox-bytes");
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("composeNotes", () => {
  it("extracts only the matching CHANGELOG section and adds the download caveat", () => {
    const log = [
      "# Changelog",
      "",
      "## [1.5.24] - 2026-11-15",
      "",
      "### Changed",
      "- Upgrade writes with 8-way concurrency.",
      "",
      "## [1.5.23] - 2026-11-15",
      "",
      "### Fixed",
      "- Older section that must not leak in.",
      "",
    ].join("\n");
    const root = repo("1.5.24", log);
    const body = composeNotes(root, "1.5.24") as string;
    expect(body).toContain("Kesonode v1.5.24");
    expect(body).toContain("kesonode-chrome-1.5.24.zip");
    expect(body).toContain("kesonode-firefox-1.5.24.zip");
    expect(body).toContain("不含内置 Google OAuth 密钥");
    expect(body).toContain("Upgrade writes with 8-way concurrency.");
    expect(body).not.toContain("Older section that must not leak in.");
  });

  it("returns null with no matching section so the caller falls back to generated notes", () => {
    const root = repo("1.5.25", "# Changelog\n\n## [1.5.24] - 2026-11-15\n\n- old\n");
    expect(composeNotes(root, "1.5.25")).toBeNull();
  });
});

describe("run", () => {
  it("dry-run plans the tag and both zips without calling git or gh", () => {
    const root = repo("1.5.24");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse") return "abc123\n";
      if (cmd === "git" && args[0] === "status") return "\n";
      return "";
    };
    const result = run(["--dry-run"], { cwd: root, exec });
    expect(result.dryRun).toBe(true);
    expect(result.tag).toBe("v1.5.24");
    expect(result.zips.chrome).toContain("kesonode-chrome-1.5.24.zip");
    expect(result.zips.firefox).toContain("kesonode-firefox-1.5.24.zip");
    // No mutating command may run in dry-run.
    expect(calls.some((c) => c[0] === "gh")).toBe(false);
    expect(calls.some((c) => c[1] === "push" || c[1] === "tag")).toBe(false);
  });

  it("refuses to release a dirty working tree", () => {
    const root = repo("1.5.24");
    const exec = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") return "abc123\n";
      if (cmd === "git" && args[0] === "status") return " M src/foo.ts\n";
      return "";
    };
    expect(() => run([], { cwd: root, exec })).toThrow(/not clean/);
  });

  it("refuses when a zip is missing", () => {
    const root = repo("1.5.24");
    rmSync(join(root, "插件版本", "v1.5.24", "kesonode-firefox-1.5.24.zip"));
    expect(() => run([], { cwd: root, exec: () => "" })).toThrow(/Missing firefox package/);
  });

  it("creates the tag and release on a clean tree with no existing release", () => {
    const root = repo("1.5.24", "## [1.5.24]\n\n- thing\n");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
      if (cmd === "git" && args[0] === "status") return "\n";
      if (cmd === "git" && args[0] === "rev-parse" && String(args[1]).startsWith("refs/tags/")) {
        throw new Error("no such tag");
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") throw new Error("no release");
      return "";
    };
    const result = run([], { cwd: root, exec });
    expect(result.releaseExists).toBe(false);
    expect(calls.some((c) => c[0] === "git" && c[1] === "tag" && c[2] === "v1.5.24")).toBe(true);
    expect(calls.some((c) => c[0] === "git" && c[1] === "push" && c[2] === "origin" && c[3] === "v1.5.24")).toBe(true);
    expect(calls.some((c) => c[0] === "gh" && c[1] === "release" && c[2] === "create" && c.includes("v1.5.24"))).toBe(true);
  });

  it("leaves an existing release untouched (idempotent re-run)", () => {
    const root = repo("1.5.24");
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse") return "abc123\n";
      if (cmd === "git" && args[0] === "status") return "\n";
      return ""; // gh release view succeeds -> exists
    };
    const result = run([], { cwd: root, exec });
    expect(result.releaseExists).toBe(true);
    expect(calls.some((c) => c[0] === "gh" && c[2] === "create")).toBe(false);
  });
});
