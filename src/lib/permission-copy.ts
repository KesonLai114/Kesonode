/**
 * Human wording for a browser permission.
 *
 * The permission screens used to print the identifier the browser uses — `history`,
 * `tabs`, `management`, `https://host/*` — in a monospace row. That is the one string on
 * the page a person cannot act on: they have never seen `management`, and nothing in the
 * word tells them it means "the list of extensions you have installed". People decline
 * prompts they cannot read, so the identifier is now only a fallback and a tooltip.
 *
 * The wording is NOT duplicated here. Each permission points at the message key the
 * surrounding product already uses for the same thing — `datatype_history` in the wizard,
 * in Settings → Data types and here — because three screens describing `history` three
 * different ways is how a user ends up agreeing to something they did not read. That is
 * the same reason the first-sync answers share their keys (see i18n.test.ts).
 *
 * Keys rather than sentences, so this module stays testable without a browser: the tests
 * can prove every optional permission in the manifest has wording without standing up
 * `chrome.i18n`.
 */
export type PermissionCopy = {
  /** Message key for the permission's name, in the user's words. */
  nameKey: string;
  /** Message key for what Kesonode does with it. */
  purposeKey?: string;
};

/**
 * Every permission the manifest can ask for at runtime, plus the two required ones, so a
 * future screen can explain the install-time warning as well.
 *
 * `tabGroups` deliberately reuses the Settings row rather than naming the namespace: the
 * permission exists so group NAMES and COLOURS survive a restore, which is what that row
 * already says.
 */
const BY_ID: Record<string, PermissionCopy> = {
  bookmarks: { nameKey: "datatype_bookmarks", purposeKey: "datatype_bookmarks_desc" },
  history: { nameKey: "datatype_history", purposeKey: "datatype_history_desc" },
  tabs: { nameKey: "datatype_sessions", purposeKey: "datatype_sessions_desc" },
  management: { nameKey: "datatype_extensions", purposeKey: "datatype_extensions_desc" },
  tabGroups: { nameKey: "opt_tab_groups_label", purposeKey: "opt_tab_groups_desc" },
};

/**
 * The wording for one permission id, or null when there is none.
 *
 * Null is a real answer, not an error: a browser can add a permission this build has never
 * heard of, and silently dropping the row would hide what is being asked for. The caller
 * prints the id in that case — ugly, but honest, and it is the string the browser's own
 * settings screen will show.
 */
export function describePermission(id: string): PermissionCopy | null {
  return BY_ID[id] ?? null;
}

/** Every id this build can word, for the test that keeps it in step with the manifest. */
export function knownPermissionIds(): string[] {
  return Object.keys(BY_ID);
}
