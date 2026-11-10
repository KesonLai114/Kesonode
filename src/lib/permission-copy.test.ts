import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describePermission, knownPermissionIds } from "@/lib/permission-copy";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../public/manifest.json"), "utf8"),
) as { permissions?: string[]; optional_permissions?: string[] };

describe("permission wording", () => {
  it("words every optional permission the manifest can request", () => {
    // The permission screen lists what is missing, and an id with no wording is printed
    // as the raw identifier — the exact failure this module exists to end. A new optional
    // permission therefore has to arrive with its sentence.
    const optional = (manifest.optional_permissions ?? []).map((p) => p.replace(/^.*:/, ""));
    const unworded = optional.filter((p) => !describePermission(p));
    expect(unworded).toEqual([]);
  });

  it("words the required permissions a user sees named in the install warning", () => {
    for (const id of ["bookmarks"]) expect(describePermission(id)).not.toBeNull();
  });

  it("answers null for an id it has never seen", () => {
    // A browser can add a permission this build predates. Null keeps the caller honest:
    // it prints the id rather than dropping the row and hiding what is being asked for.
    expect(describePermission("someFuturePermission")).toBeNull();
  });

  it("does not repeat a message key between two different permissions", () => {
    // Sharing a key is how two rows end up saying the same thing: "Open tabs" for both
    // `tabs` and `tabGroups` reads as a duplicate request for the same consent.
    const names = knownPermissionIds().map((id) => describePermission(id)!.nameKey);
    expect(new Set(names).size).toBe(names.length);
  });
});
