import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs build script, no types, imported for what it guards.
import { hasSecret, versionProblems, bundleProblems } from "./build-variant.mjs";

// The last gate before a zip is published. Getting it wrong in one direction ships a
// store build to a store without Kesonode's OAuth secret, so Drive sign-in fails for
// everyone who installs it. Getting it wrong in the OTHER direction puts that secret on
// a public release page, which is why the mixed case below is the one that matters.

const SECRET = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
const made: string[] = [];

function built(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "konode-variant-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hasSecret looks at every bundle, not just the worker", () => {
  it("finds a secret that is only in a UI chunk", () => {
    // The case the old check waved through. `gdrive-oauth.ts` reads the secret at module
    // scope and Settings imports from it, so Vite inlines it into a UI chunk as well as
    // into background.js. Building the worker with `--mode source` over a store dist/
    // leaves exactly this: a clean worker beside a chunk that still carries the secret,
    // certified "no secret" and filed under source/ for the release page.
    const dir = built({
      "background.js": "console.log('clean worker');",
      "chunks/theme-abc123.js": `const s="${SECRET}";`,
    });

    expect(hasSecret(dir)).toBe(true);
  });

  it("finds a secret in the worker alone", () => {
    const dir = built({
      "background.js": `const s="${SECRET}";`,
      "chunks/theme-abc123.js": "console.log('ui');",
    });

    expect(hasSecret(dir)).toBe(true);
  });

  it("answers no for a build that carries none", () => {
    const dir = built({
      "background.js": "console.log('clean');",
      "chunks/theme-abc123.js": "console.log('ui');",
    });

    expect(hasSecret(dir)).toBe(false);
  });

  it("is not fooled by a non-.js file, and does not read one", () => {
    // A locale or a source map mentioning the shape is not a compiled-in secret.
    const dir = built({
      "background.js": "console.log('clean');",
      "notes.txt": `this documents ${SECRET} and is not shipped code`,
    });

    expect(hasSecret(dir)).toBe(false);
  });

  it("refuses to answer for a directory that was never built", () => {
    const dir = built({ "chunks/theme-abc123.js": "console.log('ui');" });

    expect(() => hasSecret(dir)).toThrow(/build before packaging/i);
  });
});

// The zip FILENAME comes from package.json while the manifest INSIDE it is copied out
// of dist/. v1.5.5 shipped as a 1.5.5-named zip with a 1.5.4 manifest, which made a
// source fix look like it had never been built. These two pure functions are the parts
// of the gate that can be tested without calling process.exit().
function versioned(pkg: string, canonical: string, dist: string | null) {
  const root = mkdtempSync(join(tmpdir(), "konode-version-"));
  made.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: pkg }));
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "public", "manifest.json"), JSON.stringify({ version: canonical }));
  const distDir = join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  if (dist !== null) {
    writeFileSync(join(distDir, "manifest.json"), JSON.stringify({ version: dist }));
  }
  return { root, dist: distDir };
}

describe("versionProblems — a zip's name must match the manifest inside it", () => {
  it("accepts the same version in all three places", () => {
    const { root, dist } = versioned("1.5.6", "1.5.6", "1.5.6");
    expect(versionProblems(root, dist).problems).toEqual([]);
  });

  it("rejects a stale dist/ — the exact 1.5.5 / 1.5.4 mismatch", () => {
    const { root, dist } = versioned("1.5.5", "1.5.5", "1.5.4");
    expect(versionProblems(root, dist).problems.join("\n"))
      .toContain("dist/manifest.json is 1.5.4, expected 1.5.5");
  });

  it("rejects an unstamped public manifest and reports a missing built one", () => {
    const unstamped = versioned("1.5.6", "1.5.5", "1.5.6");
    expect(versionProblems(unstamped.root, unstamped.dist).problems.join("\n"))
      .toContain("public/manifest.json is 1.5.5, expected 1.5.6");

    const missing = versioned("1.5.6", "1.5.6", null);
    expect(versionProblems(missing.root, missing.dist).problems.join("\n"))
      .toContain("dist/manifest.json is (missing)");
  });
});

// An ESM chunk run as a classic script is what produces "Unexpected token 'export'"
// and a wall of minified lucide code. Mixing two builds in one folder is the usual
// cause, so the gate checks both the script tags and the referenced files.
function goodBundle(): Record<string, string> {
  return {
    "manifest.json": JSON.stringify({
      background: { service_worker: "background.js", type: "module" },
    }),
    "background.js": "console.log('worker');",
    "popup.js": "console.log('ui');",
    "chunks/puzzle-abc123.js": "export const puzzle = 1;",
    "index.css": "body{}",
    "popup.html":
      '<script type="module" src="/popup.js"></script>' +
      '<link rel="modulepreload" href="/chunks/puzzle-abc123.js">' +
      '<link rel="stylesheet" href="/index.css">',
  };
}

describe("bundleProblems — HTML and chunks must come from one build", () => {
  it("accepts a complete module build", () => {
    expect(bundleProblems(built(goodBundle())).problems).toEqual([]);
  });

  it("catches a <script> that would run an ESM chunk as a classic script", () => {
    const files = goodBundle();
    files["popup.html"] = files["popup.html"].replace('type="module" ', "");
    expect(bundleProblems(built(files)).problems.join("\n")).toContain('type="module"');
  });

  it("catches an HTML that references a chunk from another build", () => {
    const files = goodBundle();
    files["popup.html"] = files["popup.html"].replace("puzzle-abc123.js", "puzzle-OLD.js");
    expect(bundleProblems(built(files)).problems.join("\n")).toContain("missing from the build");
  });

  it("catches a worker that is not declared as a module", () => {
    const files = goodBundle();
    files["manifest.json"] = JSON.stringify({ background: { service_worker: "background.js" } });
    expect(bundleProblems(built(files)).problems.join("\n")).toContain('need "module"');
  });
});
