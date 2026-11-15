/**
 * Regression guard for the two file-system dialogs in the upgrade flow.
 *
 * Both `showDirectoryPicker()` and a file input's picker need a live user gesture.
 * The previous implementation opened the folder dialog first and clicked the file input
 * at the END of a chain of awaits — Chrome can refuse that outright, and macOS titled
 * the first dialog "where should this site save changes" while greying out every .zip,
 * so users thought they could not select the new package at all.
 *
 * There is no DOM environment in this test suite, so these assertions read the source
 * instead of rendering the component. They are deliberately narrow: they only prove
 * that the two picker calls still happen in the synchronous part of their click.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "update-section.tsx"), "utf8");

/** The body of a `const name = (...) => { ... }` declaration, matched by brace depth. */
function bodyOf(name: string): string {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} no longer exists`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`${name} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`${name} body is unterminated`);
}

/** Everything that still runs before the click's transient activation expires. */
function synchronousPart(text: string): string {
  const firstAwait = text.indexOf("await ");
  return firstAwait < 0 ? text : text.slice(0, firstAwait);
}

describe("the one-click upgrade opens both dialogs inside a user gesture", () => {
  it("opens the zip picker synchronously in the first click, before any await", () => {
    expect(source).toContain("const startUpgrade = () => {");
    expect(synchronousPart(bodyOf("startUpgrade"))).toContain("fileRef.current?.click()");
  });

  it("creates the directory-picker promise synchronously in the second click", () => {
    const beforeAwait = synchronousPart(bodyOf("grantFolderAndInstall"));
    expect(beforeAwait).toContain("pickInstallFolder()");
    expect(beforeAwait.indexOf("pickInstallFolder()")).toBeLessThan(
      beforeAwait.indexOf("void (async")
    );
  });

  it("asks for the package before it asks for a folder", () => {
    const onFileChange = bodyOf("onFileChange");
    expect(onFileChange).toContain("extractPackage(");
    expect(onFileChange).toContain('setFlow({ kind: "need-folder"');
    expect(onFileChange.indexOf("extractPackage(")).toBeLessThan(
      onFileChange.indexOf('setFlow({ kind: "need-folder"')
    );
  });
});
