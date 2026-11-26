/**
 * The writes the merge made itself, so the recorders can tell them from the user's.
 *
 * `importing` is a window in TIME: it is true while a merge runs, and the browser delivers
 * onChanged/onMoved/onRemoved whenever it gets round to it — often after the merge that
 * caused it has already returned. That window cost us in both directions.
 *
 * Late: an echo of the merge's own rename arrived outside the window, read as a user rename
 * and went out re-stamped with `Date.now()`, outranking every peer's copy of the same
 * operation. That is the sync loop reported from the field.
 *
 * Early: everything the user did INSIDE the window was dropped. A sync runs every minute and
 * takes seconds, so a folder renamed at the wrong moment recorded nothing. The new title
 * still rode along in the tree, but the operation did not, and the peers — which match
 * folders by title — found no folder of that name and made one beside the user's.
 *
 * The same window sat in front of MOVES and DELETIONS, where losing the record is worse:
 * a placement and a removal travel ONLY as those records — a peer never relocates or drops
 * a bookmark because the tree says so. A user who reorganised bookmarks while a sync was
 * merging (the sync fires on every change, and the merge covers every peer) had every move
 * and delete silently discarded: the moved bookmarks stayed in the old folder on every
 * other device, the deleted ones came back, and the emptied folder could never be pruned.
 * That was reported from the field as "sync stopped working".
 *
 * So the merge says what it wrote, and the recorder skips the one event that matches it, by
 * CONTENT rather than by timing (a move by its target parent, a removal by its node id).
 * Every other change is recorded, mid-sync or not.
 *
 * Deliberately a leaf module: no chrome, no storage, nothing to import. It is in-memory
 * state in a service worker that can be torn down at any moment, which is fine — a worker
 * that dies mid-merge loses the records AND the events they were waiting for.
 */

/**
 * How long an unclaimed write stays claimable.
 *
 * Far beyond any plausible event delay, because the two failure modes are not equal: an
 * entry that expires too early lets an echo through, which is the field loop, while one
 * that lingers can only swallow the same write on the same node (a rename to the same
 * title, a move to the same parent), and only if the merge's own event was never
 * delivered at all. A removal cannot be swallowed twice: the node is gone.
 */
const TTL_MS = 30_000;

interface SelfWrite {
  title: string;
  at: number;
}

interface SelfMove {
  /** The parent the merge moved the node into; the event must name the same one. */
  parentId: string | undefined;
  at: number;
}

/** node id → the titles the merge wrote to it and has not seen come back yet. */
const pending = new Map<string, SelfWrite[]>();
/** node id → the placements the merge made and has not seen come back yet. */
const pendingMoves = new Map<string, SelfMove[]>();
/** node id → when the merge removed it. A removed node can't be removed again, so ids suffice. */
const pendingRemovals = new Map<string, number>();

function prune(now: number): void {
  for (const [id, list] of pending) {
    const live = list.filter((w) => now - w.at < TTL_MS);
    if (live.length) pending.set(id, live);
    else pending.delete(id);
  }
  for (const [id, list] of pendingMoves) {
    const live = list.filter((w) => now - w.at < TTL_MS);
    if (live.length) pendingMoves.set(id, live);
    else pendingMoves.delete(id);
  }
  for (const [id, at] of pendingRemovals) {
    if (now - at >= TTL_MS) pendingRemovals.delete(id);
  }
}

/**
 * Test seam: the browser has delivered every echo of the merge's writes.
 *
 * A real browser reports each move, rename and removal the merge made, and each report
 * claims its entry. A fake one does not, so in a test the entries would sit here for the
 * whole TTL and claim the next drag of the same bookmark as the merge's own echo.
 */
export function forgetSelfWritesForTest(): void {
  pending.clear();
  pendingMoves.clear();
  pendingRemovals.clear();
}

/**
 * The merge is about to write `title` to `id`.
 *
 * Called BEFORE the write, not after: nothing promises that the write resolves before its
 * own event is delivered. A write that then fails leaves an entry nobody claims, which the
 * TTL clears.
 */
export function noteSelfTitleWrite(id: string, title: string): void {
  const now = Date.now();
  prune(now);
  const list = pending.get(id) ?? [];
  list.push({ title, at: now });
  pending.set(id, list);
}

/**
 * Is this onChanged the merge's own write coming back? Claims the record if so, so a
 * second, genuine rename to the same title is still recorded.
 */
export function takeSelfTitleWrite(id: string, title: string): boolean {
  const now = Date.now();
  prune(now);
  const list = pending.get(id);
  if (!list) return false;
  const i = list.findIndex((w) => w.title === title);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) pending.delete(id);
  return true;
}

/**
 * The merge is about to move `id` into `parentId`.
 *
 * Called BEFORE the write for the same reason as the titles: an event can be delivered
 * before the write's promise settles. A move that then fails leaves an entry nobody claims,
 * which the TTL clears.
 */
export function noteSelfMove(id: string, parentId: string | undefined): void {
  const now = Date.now();
  prune(now);
  const list = pendingMoves.get(id) ?? [];
  list.push({ parentId, at: now });
  pendingMoves.set(id, list);
}

/**
 * Is this onMoved the merge's own move coming back? Claims it. Matched by the TARGET PARENT,
 * not by id alone: the user dragging the same bookmark somewhere else is still their move
 * and must be recorded.
 */
export function takeSelfMove(id: string, parentId: string | undefined): boolean {
  const now = Date.now();
  prune(now);
  const list = pendingMoves.get(id);
  if (!list) return false;
  const i = list.findIndex((w) => w.parentId === parentId);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) pendingMoves.delete(id);
  return true;
}

/** The merge is about to remove the node `id` (a bookmark, or a shell it just pruned). */
export function noteSelfRemoval(id: string): void {
  const now = Date.now();
  prune(now);
  pendingRemovals.set(id, now);
}

/**
 * Is this onRemoved the merge's own removal coming back? Claims it.
 *
 * By id, because a node that is gone cannot be removed a second time — there is no user
 * action this could swallow. Without it, every bookmark the merge deleted to honour a
 * peer's tombstone was recorded as a deletion of THIS device's own and re-published
 * re-stamped, and every pruned shell became a folder-delete this device demanded of the
 * others.
 */
export function takeSelfRemoval(id: string): boolean {
  const now = Date.now();
  prune(now);
  if (!pendingRemovals.has(id)) return false;
  pendingRemovals.delete(id);
  return true;
}

/**
 * Test seam: drop what one test's merge wrote, so it cannot answer for the next one's.
 *
 * Wired into the suite's global `beforeEach` rather than each test file's, because the
 * bookmark fake hands out the same ids to every test — an unclaimed entry from one would
 * otherwise silence a rename in another, which is how the first attempt at this went wrong.
 */
export function resetSelfWrites(): void {
  pending.clear();
  pendingMoves.clear();
  pendingRemovals.clear();
}
