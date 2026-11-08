import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reviewPageFor } from "./store-review";

// The upstream store ids (the Chromium key and the upstream Firefox gecko id) must not
// get a rating link here: a rating there is a rating for a different extension. Kesonode
// now carries its OWN gecko id (set in scripts/make-firefox-manifest.mjs); the gecko-id
// test below reads it straight from that script so it can never drift from the built manifest.
describe("reviewPageFor", () => {
  it("offers no rating page for the frozen upstream store ids", () => {
    expect(reviewPageFor("mmlfiiimnpnjcjhhbldenpcmnibedkfa")).toBeNull();
    expect(reviewPageFor("konabe@proton.me")).toBeNull();
  });

  it("offers nothing for an install no store knows", () => {
    expect(reviewPageFor("ccndglojjbnpepoalfggnmdelbnacfli")).toBeNull(); // the local dev build
    expect(reviewPageFor("")).toBeNull();
  });

  it("names no upstream store or project URL", () => {
    const source = readFileSync(resolve(__dirname, "./store-review.ts"), "utf8");
    expect(source).not.toMatch(/konabe-studio|konabe@proton\.me|addon\/konode|detail\/konode/);
  });

  // The gecko id is set by the Firefox manifest script, not in src. If it ever changed,
  // a future listing lookup would silently miss every Firefox install.
  it("knows the gecko id the Firefox build is given", () => {
    const script = readFileSync(resolve(__dirname, "../../scripts/make-firefox-manifest.mjs"), "utf8");
    const gecko = script.match(/GECKO_ID\s*=\s*["']([^"']+)["']/)?.[1];
    expect(gecko).toBeTruthy();
    expect(reviewPageFor(gecko!)).toBeNull();
  });
});
