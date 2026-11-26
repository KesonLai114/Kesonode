/**
 * The time service: bookmark order is timed by the STORAGE's clock, not this device's.
 *
 * "Whose drag was later" is settled by comparing the timestamps on two placement records,
 * and each device stamps its own with its own clock. Two browsers whose clocks differ by
 * five minutes cannot answer that question: a drag made now on the slow one loses to a
 * drag made four minutes ago on the fast one, every time, for five minutes.
 *
 * An extension cannot set the system clock, and should not have to. Every response from
 * the storage carries an HTTP `Date` header, which is the storage's own clock. So this
 * module keeps a measurement of how far THIS device's clock is from the storage's:
 *
 *   - every backend response is folded in as it arrives (`observedFetch`), which costs
 *     nothing extra;
 *   - one header names only the SECOND the response was made in, so one response leaves a
 *     range a second and a round trip wide. Responses made either side of a second
 *     boundary, close together, cut that range down to about one round trip;
 *   - when the range is still wide, the sync asks for a dozen more responses on purpose,
 *     spread across the range (`probeServerClock`), at most every ten minutes.
 *
 * Everything here is best effort. A storage that sends no `Date`, a request that fails, a
 * range that never narrows: the service goes quiet and `serverNow()` is the local clock.
 *
 * What it does NOT change: the system clock, and the timestamps of anything but placement
 * records and the move-storm windows (see bookmarks-handler.ts). Deletions, renames and
 * the browser's own `dateAdded` are still on each device's clock.
 */
import { logger } from "@/lib/utils/logger";
import { getServerClockState, updateServerClockState } from "@/lib/utils/storage";

const SECOND = 1000;
/** A range this narrow answers "whose drag was later" as well as anything can. */
export const CLOCK_SHARP_MS = 150;
/** How often a probe may run, how long one may take, and how many rounds of it there are. */
const PROBE_INTERVAL_MS = 10 * 60_000;
const PROBE_BUDGET_MS = 4500;
/** Requests in the one burst, and how far apart they are made. */
const PROBE_PINGS = 14;
const PROBE_GAP_MS = 80;
/** No burst can make the range narrower than the round trip, so this is where it stops. */
const PROBE_SLACK_MS = 300;
/**
 * A range is built from responses over at most this long. Clocks drift, so bounds set
 * half a day ago are not intersected with a response now: the range starts again, and
 * the next sync probes it back down.
 */
const WINDOW_MAX_AGE_MS = 12 * 60 * 60_000;
/** A first reading is only a second wide, so only a gap this large is worth telling the user. */
const NOTEWORTHY_MS = 2000;

/** The storage's clock, read from an HTTP `Date` header, in ms since the epoch. */
export function parseHttpDate(header: string | null | undefined): number | null {
  if (!header) return null;
  const ms = Date.parse(header.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** How wide the remaining doubt about the offset is. Infinite until the first response. */
export function clockDoubt(s: { samples: number; lo: number; hi: number }): number {
  return s.samples ? Math.max(0, s.hi - s.lo) : Number.POSITIVE_INFINITY;
}

/** What the storage's clock reads now. The local clock until anything has been measured. */
export async function serverNow(): Promise<number> {
  const s = await getServerClockState();
  return Date.now() + (s.samples ? (s.lo + s.hi) / 2 : 0);
}

function describeOffset(offset: number): string {
  const abs = Math.abs(offset);
  // Whole minutes or whole seconds: a first reading is half a second out either way.
  const ahead = offset < 0;
  if (abs >= 60_000) return `${Math.round(abs / 60_000)} min ${ahead ? "ahead of" : "behind"}`;
  return `${Math.round(abs / 1000)} s ${ahead ? "ahead of" : "behind"}`;
}

/**
 * Fold one response in. `sentAt`/`receivedAt` are the local clock just before the request
 * went out and just after the response came back.
 *
 * The response was MADE at some instant between those two, and inside the second the
 * header names. So at the moment it was made, the local clock was somewhere in
 * `[made - receivedAt, made + 1000 - sentAt]` BEHIND the storage's: a second, and the
 * round trip on top. That range is
 * intersected with the one held. An empty intersection means one of the two clocks was
 * SET since (the device's by its owner or by NTP, the storage's by its administrator),
 * and the range starts again from this response.
 */
export function noteServerDate(
  header: string | null | undefined, sentAt: number, receivedAt: number,
): Promise<void> {
  const made = parseHttpDate(header);
  if (made === null || !(receivedAt >= sentAt)) return Promise.resolve();
  const lo = made - receivedAt;
  const hi = made + SECOND - sentAt;
  // Took a second or more (a sleeping laptop, a stalled network): it says nothing.
  if (receivedAt - sentAt > SECOND) return Promise.resolve();
  let note: string | null = null;
  const fresh: ServerClockSample = { lo, hi, rtt: receivedAt - sentAt };
  return updateServerClockState((cur) => {
    const next = {
      ...cur, lo, hi, samples: 1, since: receivedAt, measuredAt: receivedAt,
      rtt: fresh.rtt, settled: false,
    };
    if (cur.samples === 0) {
      const offset = (lo + hi) / 2;
      if (Math.abs(offset) >= NOTEWORTHY_MS) {
        note = `This device's clock is ${describeOffset(offset)} the storage's. From now on, ` +
          "bookmark order is timed by the storage's clock, so a later drag wins on every device.";
      }
      return next;
    }
    if (receivedAt - cur.since > WINDOW_MAX_AGE_MS) return next;
    const nlo = Math.max(cur.lo, lo);
    const nhi = Math.min(cur.hi, hi);
    if (nlo > nhi) {
      note = "The clock changed under Kesonode (this device's was set, or the storage's was). " +
        "Bookmark order is being timed by the storage's clock again from this measurement on.";
      return next;
    }
    return { ...cur, lo: nlo, hi: nhi, samples: cur.samples + 1, measuredAt: receivedAt, rtt: fresh.rtt };
  }).then(() => { if (note) logger.event("Clock", note); }).catch(() => {
    // The measurement is an improvement, never a requirement.
  });
}

interface ServerClockSample { lo: number; hi: number; rtt: number }

/**
 * `fetch`, and the storage's clock read off the response. Every request every backend
 * makes goes through here, so the measurement refreshes itself with ordinary traffic.
 */
export async function observedFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const sentAt = Date.now();
  const res = await fetch(...args);
  try {
    const header = res.headers.get("date");
    if (header) void noteServerDate(header, sentAt, Date.now());
  } catch {
    // A response with no readable headers (an opaque one) carries nothing to read.
  }
  return res;
}

export interface ProbeTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realTiming: ProbeTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** As narrow as a connection with this round trip and this range can make it. */
function asNarrowAsGets(s: { lo: number; hi: number; rtt: number }): number {
  return Math.max(CLOCK_SHARP_MS, 2 * s.rtt + PROBE_SLACK_MS);
}

/**
 * Ask for a few more responses on purpose, to cut the range down.
 *
 * One request first, alone: a storage that is unreachable or sends no `Date` must cost
 * ONE request, not a dozen. Then, if the range is still wide, one burst: a response
 * only narrows the range when it was MADE either side of a second boundary from an
 * earlier one, and after one response the boundary could be anywhere in the next
 * second. So the burst spans more than a whole second, 80 ms between requests: it
 * cannot miss the boundary, and the pair made either side of it pins the offset down
 * to about one round trip plus that gap.
 */
export async function probeServerClock(
  ping: () => Promise<unknown>, timing: ProbeTiming = realTiming,
): Promise<void> {
  const start = timing.now();
  await updateServerClockState((cur) => ({ ...cur, probedAt: start }));
  let reached = false;
  try { await ping(); reached = true; } catch { /* unreachable: nothing to learn now */ }
  // Serialized behind whatever that response folded in (it does not wait for that).
  let s = await updateServerClockState((cur) => cur);
  const before = s.hi - s.lo;
  if (!reached) return;
  if (s.samples === 0 || s.measuredAt < start) {
    // It answered without a `Date`. Probing cannot help, so do not ask again.
    await updateServerClockState((cur) => ({ ...cur, settled: true }));
    return;
  }
  // Launched on an absolute schedule, so a slow request cannot push the rest late.
  const first = timing.now();
  for (let k = 0; k < PROBE_PINGS; k++) {
    await timing.sleep(Math.max(0, first + k * PROBE_GAP_MS - timing.now()));
    try { void ping(); } catch { /* one of several failing costs the burst its share */ }
  }
  // Behind every response the burst folded in.
  await updateServerClockState((cur) => cur);
  if (timing.now() - start > PROBE_BUDGET_MS) return;
  s = await getServerClockState();
  const exhausted = s.hi - s.lo >= before - 20;
  await updateServerClockState((cur) => ({
    ...cur,
    // As narrow as this connection makes it: one more probe would come back the same.
    settled: cur.samples > 0 && (exhausted || cur.hi - cur.lo <= asNarrowAsGets(cur)),
  }));
}

/**
 * Called once a sync cycle, with a cheap authenticated request to the storage. Probes
 * only when the range is still wide and the last probe was ten minutes ago.
 */
export async function ensureServerClock(ping: () => Promise<unknown>, timing: ProbeTiming = realTiming): Promise<void> {
  const s = await getServerClockState();
  if (s.samples === 0 && s.settled) return;
  if (s.samples > 0 && (s.settled || s.hi - s.lo <= asNarrowAsGets(s))) return;
  if (timing.now() - s.probedAt < PROBE_INTERVAL_MS) return;
  await probeServerClock(ping, timing);
}
