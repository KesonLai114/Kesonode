/**
 * Local change guard — stops a runaway rewrite of THIS browser's bookmark tree
 * from being published to every peer, without delaying the user's own bulk edits.
 *
 * Why this exists: the bookmarks API tells an extension that a bookmark appeared,
 * changed or was removed, but never WHO did it. A batch of bookmarks that Chrome Sync,
 * Firefox Sync or another extension just pushed into this browser is indistinguishable
 * from the user editing them, so the recorders stamp it `Date.now()` and the next sync
 * broadcasts it as this device's newest intent (README "Running Kesonode alongside your
 * browser's own sync"). The mass-delete guard protects the RECEIVING side; nothing
 * protected the SENDING side.
 *
 * The hard part is that a single large change is NOT suspicious: deleting a 40-bookmark
 * folder is one ordinary user action, and it must reach the other devices immediately.
 * What is suspicious is a tree that keeps changing by a large amount on EVERY cycle and
 * never settles — a browser's own sync arriving in waves, or two sync systems feeding
 * each other's writes back and forth. So the guard measures the change between two
 * consecutive cycles (not against a distant baseline) and only holds publishing after
 * several such cycles in a row. One quiet cycle clears it, so no user action is ever
 * held for more than the check itself.
 *
 * Holding means NOT PUBLISHING. Nothing is deleted, reverted or blocked on the way in:
 * peers are still pulled and merged every cycle. A restore point and an Activity-log
 * warning are written once per incident (sync-engine.ts).
 *
 * Purely local working state. Nothing here changes the SyncPacket wire format, the
 * `konode_*` file names, the folder name, the checksum or the E2EE parameters:
 * `src/lib/compat/protocol.ts` stays frozen.
 */
import type { SyncBookmark } from "@/lib/types";
import { rootKindOf } from "@/lib/utils/bookmark-roots";
import { canonicalUrlKey } from "@/lib/utils/url";
import { getGuardState, setGuardState, type StoredGuardState } from "@/lib/utils/storage";

/** At least this many entries must change between two cycles before it counts as churn.
 * A user renaming a handful of bookmarks must never trip the guard. */
export const GUARD_ABSOLUTE_FLOOR = 20;
/** ...or this share of the previous cycle's tree, whichever is LARGER, so a large tree
 * is not held up by a proportionally small import. */
export const GUARD_PERCENT = 30;
/** Consecutive large-change cycles before publishing is held. One is a user action;
 * three in a row without ever settling is a loop or an arriving wave. */
export const GUARD_CHURN_ROUNDS = 3;
/** Even one cycle this large is held immediately (a runaway extension creating a whole
 * tree at once). A quiet cycle still clears it, so a legitimate bulk import is only
 * delayed by one sync. */
export const GUARD_IMMEDIATE_FLOOR = 500;

/** The shape lives in storage.ts so that module never has to import the sync layer. */
export type GuardState = StoredGuardState;

/** Tunables for the guard, all overridable from settings so the user stays in control. */
export interface GuardConfig {
  /** Master switch. Off → the guard still tracks the tree but never holds. */
  enabled: boolean;
  /** Absolute floor (entries) before the percentage-of-tree check. */
  floor: number;
  /** Percentage of the previous tree that also counts as "large". */
  ratio: number;
  /** A single cycle changing this many entries is held immediately. */
  immediateFloor: number;
  /** Consecutive large-change cycles before publishing is held. */
  churnRounds: number;
}

export interface DriftVerdict {
  /** True → do not publish this device's bookmark file this cycle. */
  hold: boolean;
  /** Entries that differ from the previous cycle's tree. */
  changed: number;
  /** The cap `changed` was compared against. */
  cap: number;
  /** Consecutive large-change cycles, including this one. */
  unstableRounds: number;
  /** True on the very first cycle, when there was nothing to compare with. */
  firstSighting: boolean;
  /** True when `GUARD_IMMEDIATE_FLOOR` alone tripped the guard. */
  immediate: boolean;
  /** True when this cycle ended a streak of held rounds (sets have just settled). */
  cleared: boolean;
}

/**
 * One string per bookmark: which root, which folder path, which title, which address.
 *
 * Keyed the way `conflict-diff.ts` keys a bookmark (canonical URL, root by kind rather
 * than by id/title) so the same tree on Chrome and Firefox produces the same entries,
 * and a title change or a move counts as a change without counting the whole tree.
 * Sorted and de-duplicated: the order a browser enumerates folders in is not a
 * difference, and a bookmark held twice in two folders is two entries.
 */
export function guardEntries(tree: SyncBookmark[]): string[] {
  const out = new Set<string>();
  const roots = tree[0]?.children ?? tree;
  roots.forEach((root, i) => {
    const kind = rootKindOf(root);
    const top = kind === "menu" ? "other" : kind ?? `root:${root.title?.trim().toLowerCase() || i}`;
    const walk = (nodes: SyncBookmark[] | undefined, path: string[]): void => {
      for (const n of nodes ?? []) {
        if (n._deleted) continue;
        if (n.url) {
          out.add([top, ...path, n.title ?? "", canonicalUrlKey(n.url)].join("\u0000"));
        } else {
          walk(n.children, [...path, n.title ?? ""]);
        }
      }
    };
    walk(root.children, []);
  });
  return [...out].sort();
}

/** How many entries one side has that the other does not, in both directions. */
function changedEntries(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let n = 0;
  for (const e of A) if (!B.has(e)) n++;
  for (const e of B) if (!A.has(e)) n++;
  return n;
}

/**
 * Compare the tree about to be published with the one seen on the previous cycle.
 *
 * Runs on the PRE-MERGE payload in `syncType`, so this cycle's own peer fold is not
 * mistaken for local churn. The state is per-device local working state; the engine
 * calls this exactly once per bookmark sync cycle. `config` carries the user's settings
 * so the guard can be turned off or tuned without touching this module.
 */
export async function evaluateLocalDrift(
  tree: SyncBookmark[],
  config?: Partial<GuardConfig>
): Promise<DriftVerdict> {
  const floor = config?.floor ?? GUARD_ABSOLUTE_FLOOR;
  const ratio = config?.ratio ?? GUARD_PERCENT;
  const immediateFloor = config?.immediateFloor ?? GUARD_IMMEDIATE_FLOOR;
  const churnRounds = config?.churnRounds ?? GUARD_CHURN_ROUNDS;
  const enabled = config?.enabled ?? true;

  const entries = guardEntries(tree);
  const state = await getGuardState();

  // Guard off: keep lastEntries fresh so flipping it back on doesn't immediately trip,
  // but never hold. (A cleared streak is reported as such only while the guard is on.)
  if (!enabled) {
    await setGuardState({ lastEntries: entries, unstableRounds: 0 });
    return { hold: false, changed: 0, cap: 0, unstableRounds: 0, firstSighting: false, immediate: false, cleared: false };
  }

  // No previous tree: a fresh install, or the state was cleared. Establishing it must
  // never hold the first sync — otherwise a device joining a 5,000-bookmark group
  // would look like one enormous change and never publish anything.
  if (!state.lastEntries) {
    await setGuardState({ lastEntries: entries, unstableRounds: 0 });
    return { hold: false, changed: 0, cap: 0, unstableRounds: 0, firstSighting: true, immediate: false, cleared: false };
  }

  const changed = changedEntries(state.lastEntries, entries);
  const cap = Math.max(floor, Math.floor((state.lastEntries.length * ratio) / 100));
  const over = changed > cap;
  const unstableRounds = over ? state.unstableRounds + 1 : 0;
  const immediate = changed >= immediateFloor;
  const hold = immediate || unstableRounds >= churnRounds;
  // The streak just ended: last cycle was held, this one is large-change-free. The engine
  // uses this to log a "settled, publishing resumed" event exactly once.
  const cleared = state.unstableRounds > 0 && unstableRounds === 0;

  // `lastEntries` follows the tree even while held, so a single quiet cycle clears the
  // incident and publishing resumes without anyone having to press a button.
  await setGuardState({ lastEntries: entries, unstableRounds });
  return { hold, changed, cap, unstableRounds, firstSighting: false, immediate, cleared };
}

/** Test seam / manual reset. A cleared state is re-established on the next sync. */
export async function resetGuardState(): Promise<void> {
  await setGuardState({ lastEntries: null, unstableRounds: 0 });
}
