import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clockDoubt, ensureServerClock, noteServerDate, observedFetch, parseHttpDate,
  probeServerClock, serverNow,
} from "@/lib/utils/server-clock";
import type { ProbeTiming } from "@/lib/utils/server-clock";
import { logger } from "@/lib/utils/logger";
import {
  defaultServerClockState, getServerClockState, setServerClockState, updateServerClockState,
} from "@/lib/utils/storage";

// The time service. A storage's clock is read from HTTP `Date` headers, which name only
// the second. The world below is a storage whose clock runs `offset` ms from the device's,
// answering every request `rtt` ms later with the second it was made in, on a clock the
// test moves by hand. Every assertion about a range is checked against the TRUE offset,
// which the service never sees.

const SECOND = 1000;

class World implements ProbeTiming {
  t = Date.UTC(2026, 10, 25, 9, 21, 33, 407);
  /** The storage's clock minus this device's. */
  offset = 0;
  rtt = 40;
  /** A storage that answers without a `Date` (some proxies strip it). */
  dateless = false;
  /** Drops every request. */
  down = false;
  /** Where in the round trip the storage actually made the response (it is not the middle). */
  servedAt = 0.5;
  calls = 0;
  notes: Array<{ sent: number; made: number; received: number }> = [];

  now() { return this.t; }
  // Hand-wound: the sleep is over as soon as it is asked for.
  sleep(ms: number) { this.t += Math.max(0, ms); return Promise.resolve(); }

  /**
   * One request sent at the clock's current reading: launching it costs no time (as an
   * unawaited request costs none), but the storage makes it somewhere in the round trip.
   */
  respond(): Response {
    const made = Math.floor((this.t + this.servedAt * this.rtt + this.offset) / SECOND) * SECOND;
    this.notes.push({ sent: this.t, made, received: this.t + this.rtt });
    return new Response(null, this.dateless ? {} : { headers: { date: new Date(made).toUTCString() } });
  }

  /** What `ensureServerClock` hands over: a cheap request to the storage. */
  ping = async (): Promise<void> => {
    this.calls++;
    if (this.down) throw new Error("network");
    const at = this.t;
    const res = this.respond();
    void noteServerDate(res.headers.get("date"), at, at + this.rtt);
  };
}

let w: World;
beforeEach(() => {
  w = new World();
  vi.spyOn(Date, "now").mockImplementation(() => w.t);
  return setServerClockState(defaultServerClockState());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The range, once every response handed in so far has been folded into it. */
async function state() {
  await updateServerClockState((cur) => cur);
  return getServerClockState();
}

describe("reading the storage's clock off a response", () => {
  it("reads an HTTP date, and nothing else", () => {
    expect(parseHttpDate("Wed, 25 Nov 2026 09:21:33 GMT")).toBe(Date.UTC(2026, 10, 25, 9, 21, 33));
    expect(parseHttpDate("  Wed, 25 Nov 2026 09:21:33 GMT ")).toBe(Date.UTC(2026, 10, 25, 9, 21, 33));
    expect(parseHttpDate("yesterday")).toBeNull();
    expect(parseHttpDate("")).toBeNull();
    expect(parseHttpDate(null)).toBeNull();
    expect(parseHttpDate(undefined)).toBeNull();
  });

  it("is the device's own clock until anything was measured", async () => {
    w.offset = 5 * 60_000;
    const local = Date.now();
    expect(await serverNow()).toBe(local);
    expect(clockDoubt(await state())).toBe(Infinity);
  });

  it("brackets the true offset to a second and the round trip", async () => {
    for (const offset of [-5 * 60_000, -1, 0, 999, 1, 300_000]) {
      for (const rtt of [0, 1, 40, 800]) {
        await setServerClockState(defaultServerClockState());
        w.offset = offset; w.rtt = rtt;
        await w.ping();
        const s = await state();
        expect([rtt, offset, s.lo, s.hi]).toEqual([rtt, offset, expect.any(Number), expect.any(Number)]);
        expect(s.lo).toBeLessThanOrEqual(offset);
        expect(s.hi).toBeGreaterThan(offset);
        expect(s.hi - s.lo).toBe(SECOND + rtt);
        expect(s.samples).toBe(1);
        expect(await serverNow()).toBe(w.t + (s.lo + s.hi) / 2);
      }
    }
  });

  it("narrows to the stretch of time between two responses made either side of a second boundary", async () => {
    // Made 15 ms before the boundary and 15 ms after it, 40 ms apart door to door.
    for (const offset of [0, 300_000, -90_123]) {
      await setServerClockState(defaultServerClockState());
      const first = Math.ceil((w.t + offset) / SECOND) * SECOND - offset - 15;
      const made0 = Math.floor((first + offset) / SECOND) * SECOND;
      await noteServerDate(http(made0), first - 20, first + 20);
      const wide = (await state()).hi - (await state()).lo;
      expect(wide).toBe(SECOND + 40);
      // The next request goes out 5 ms after the first came back, and is made 30 ms after the first.
      const second = first + 30;
      await noteServerDate(http(made0 + SECOND), second - 20, second + 20);
      const s = await state();
      expect(s.samples).toBe(2);
      expect(s.hi - s.lo).toBe(70);
      expect(s.lo).toBeLessThanOrEqual(offset);
      expect(s.hi).toBeGreaterThan(offset);
    }
  });

  it("ignores a response that took a second or more, one with no date, and one with a junk date", async () => {
    await noteServerDate(null, 1_000, 1_040);
    await noteServerDate("not a date", 1_000, 1_040);
    await noteServerDate(http(6_000), 1_000, 2_500); // 1.5 s door to door

    await noteServerDate(http(5_000), 1_040, 1_000);
    expect((await state()).samples).toBe(0);
    expect((await state()).lo).toBe(0);
  });

  it("starts again when the clocks no longer agree, and says so", async () => {
    const events = vi.spyOn(logger, "event").mockImplementation(() => {});
    w.offset = 0; w.rtt = 40;
    await w.ping();
    // Since then the device's clock was set 4.6 s forward: this response was made 4.6 s
    // into the future as far as the range held is concerned.
    const made = Math.floor((w.t + 4600) / SECOND) * SECOND;
    await noteServerDate(http(made), w.t, w.t + 40);
    // One disagreement could be a cached Date; three in a row are a real change.
    await noteServerDate(http(made), w.t + 80, w.t + 120);
    await noteServerDate(http(made), w.t + 160, w.t + 200);
    const s = await state();
    expect(s.samples).toBe(1);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][0]).toBe("Clock");
    expect(events.mock.calls[0][1]).toMatch(/clock changed under Kesonode/);
    expect(s.lo).toBeLessThanOrEqual(4600);
    expect(s.hi).toBeGreaterThan(4600);
  });

  it("does not mistake one cached, stale Date for a clock change", async () => {
    // A cached response carries the Date it was FIRST made with, which can be a minute
    // old. Its derived offset is nowhere near the range already built from fresh traffic.
    // One such response must not throw that range away or tell the user the clock moved.
    const events = vi.spyOn(logger, "event").mockImplementation(() => {});
    await setServerClockState({
      ...defaultServerClockState(), samples: 6, lo: -10, hi: 30,
      since: w.t, measuredAt: w.t, probedAt: w.t, rtt: 40, settled: true,
    });
    const stale = Math.floor((w.t - 60_000) / SECOND) * SECOND;
    await noteServerDate(http(stale), w.t, w.t + 40);
    expect(events).not.toHaveBeenCalled();
    const s = await state();
    expect(s.samples).toBe(6);
    expect(s.hi - s.lo).toBeLessThan(100);
    expect(s.settled).toBe(true);
  });

  it("starts again after THREE consecutive readings that really disagree", async () => {
    const events = vi.spyOn(logger, "event").mockImplementation(() => {});
    await setServerClockState({
      ...defaultServerClockState(), samples: 6, lo: -10, hi: 30,
      since: w.t, measuredAt: w.t, probedAt: w.t, rtt: 40, settled: true,
    });
    const moved = Math.floor((w.t + 4600) / SECOND) * SECOND;
    await noteServerDate(http(moved), w.t, w.t + 40);
    await noteServerDate(http(moved), w.t + 80, w.t + 120);
    expect(events).not.toHaveBeenCalled();
    await noteServerDate(http(moved), w.t + 160, w.t + 200);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][1]).toMatch(/clock changed under Kesonode/);
    const s = await state();
    expect(s.samples).toBe(1);
    expect(s.settled).toBe(false);
  });

  it("starts again without a fuss when half a day has passed since the range was begun", async () => {
    const events = vi.spyOn(logger, "event").mockImplementation(() => {});
    await noteServerDate(http(1_000), 0, 40);
    await noteServerDate(http(13 * 3600_000 + 1_000), 13 * 3600_000, 13 * 3600_000 + 40);
    const s = await state();
    expect(s.samples).toBe(1);
    expect(s.since).toBe(13 * 3600_000 + 40);
    expect(events).not.toHaveBeenCalled();
  });

  it("tells the user once, when the device's clock is minutes out", async () => {
    const events = vi.spyOn(logger, "event").mockImplementation(() => {});
    w.offset = -5 * 60_000; // the device is five minutes AHEAD of the storage
    await w.ping();
    await w.ping();
    await state();
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][1]).toMatch(/This device's clock is 5 min ahead of the storage's/);

    events.mockClear();
    w.offset = 0; w.rtt = 40;
    await setServerClockState(defaultServerClockState());
    await w.ping();
    expect(events).not.toHaveBeenCalled();
  });

  it("loses nothing when two responses land together", async () => {
    await Promise.all([w.ping(), w.ping()]);
    expect((await state()).samples).toBe(2);
  });

  it("is read off every response fetch brings back", async () => {
    w.offset = 90_000; w.rtt = 40;
    const res = w.respond();
    vi.stubGlobal("fetch", vi.fn(async () => res));
    const back = await observedFetch("https://storage.example/", { method: "GET" });
    const s = await state();
    expect(back).toBe(res);
    expect(s.samples).toBe(1);
    expect(s.lo).toBeLessThanOrEqual(90_000);
    expect(fetch).toHaveBeenCalledWith("https://storage.example/", { method: "GET" });

    await setServerClockState(defaultServerClockState());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null)));
    await observedFetch("https://storage.example/");
    expect((await state()).samples).toBe(0);
  });
});

function http(made: number) { return new Date(made).toUTCString(); }

describe("cutting the range down on purpose", () => {
  it("brackets the true offset to about one round trip, whatever the second boundary's phase", async () => {
    // 54 phases of the second, three skews, four connection speeds, three points within
    // the round trip: 1944 probes. What is checked is that the TRUE offset is inside the
    // range the service ends with, how wide that range is, and what it cost to get there.
    let widest = 0, mostRequests = 0, longest = 0;
    for (const phase of Array.from({ length: 54 }, (_, k) => k * 37 + 11)) {
      for (const offset of [0, 300_000, -90_123]) {
        for (const rtt of [4, 40, 120, 300]) {
          for (const servedAt of [0.05, 0.5, 0.95]) {
          await setServerClockState(defaultServerClockState());
          w = new World();
          w.t += phase; w.offset = offset; w.rtt = rtt; w.servedAt = servedAt;
          const start = w.t;
          await ensureServerClock(w.ping, w);
          const s = await state();
          const doubt = s.hi - s.lo;
          expect([phase, offset, rtt, s.lo, s.hi, doubt, w.calls, s.settled]).toEqual(
            [phase, offset, rtt, expect.any(Number), expect.any(Number), doubt, w.calls, true]);
          expect(s.lo).toBeLessThanOrEqual(offset);
          expect(s.hi).toBeGreaterThan(offset);
          // No narrower than the round trip, and within one request gap of it.
          expect(doubt).toBeLessThanOrEqual(rtt + 105);
          expect(doubt).toBeLessThanOrEqual(600);
          widest = Math.max(widest, doubt);
          mostRequests = Math.max(mostRequests, w.calls);
          longest = Math.max(longest, w.t - start);
          }
        }
      }
    }
    // The first request and one burst; a second burst only if the first could not finish the job.
    // Measured: 15 requests, 1.04 s, and at worst the round trip plus 80 ms of doubt.
    expect(mostRequests).toBe(15);
    expect(longest).toBeLessThanOrEqual(1100);
    expect(widest).toBeLessThanOrEqual(380);
  });

  it("keeps asking every ten minutes while the range stays wide", async () => {
    w.offset = 300_000; w.rtt = 40;
    const real = w.ping;
    let served = 1;
    // It answers the first request with a date and every one after it without.
    const flaky = async () => { if (served-- > 0) await real(); else { w.calls++; w.t += 40; } };
    await ensureServerClock(flaky, w);
    const s = await state();
    expect(s.hi - s.lo).toBe(SECOND + 40);
    expect(s.settled).toBe(true);
    expect(w.calls).toBe(1 + 14);
    w.t += 3600_000;
    await ensureServerClock(flaky, w);
    expect(w.calls).toBe(1 + 14);
  });

  it("asks once, and not again for ten minutes, when the storage cannot be reached", async () => {
    w.down = true;
    await ensureServerClock(w.ping, w);
    await ensureServerClock(w.ping, w);
    expect(w.calls).toBe(1);
    expect((await state()).samples).toBe(0);
    w.t += 10 * 60_000;
    await ensureServerClock(w.ping, w);
    expect(w.calls).toBe(2);
  });

  it("asks once, and never again, when the storage sends no date", async () => {
    w.dateless = true;
    await ensureServerClock(w.ping, w);
    w.t += 3600_000;
    await ensureServerClock(w.ping, w);
    expect(w.calls).toBe(1);
    expect((await state()).settled).toBe(true);
    expect(await serverNow()).toBe(w.t);
  });

  it("does not ask when the range is already narrow enough", async () => {
    w.rtt = 40;
    await w.ping();
    await setServerClockState({ ...(await state()), lo: 300_000 - 30, hi: 300_000 + 30 });
    await ensureServerClock(w.ping, w);
    expect(w.calls).toBe(1);
    expect((await state()).settled).toBe(false);
  });

  it("does not ask again once a burst has settled the range", async () => {
    w.rtt = 300;
    await w.ping();
    await probeServerClock(w.ping, w);
    const after = await state();
    expect(w.calls).toBeGreaterThan(1);
    expect(after.settled).toBe(true);
    expect(after.hi - after.lo).toBeLessThanOrEqual(300 + 105);
    expect(after.lo).toBeLessThanOrEqual(0);
    expect(after.hi).toBeGreaterThan(0);
    const calls = w.calls;
    await ensureServerClock(w.ping, w);
    expect(w.calls).toBe(calls);
  });

  it("asks again once half a day has passed and an ordinary response started the range afresh", async () => {
    w.rtt = 300;
    await w.ping();
    await probeServerClock(w.ping, w);
    const calls = w.calls;
    w.t += 13 * 3600_000;
    await w.ping();
    const fresh = await state();
    expect(fresh.samples).toBe(1);
    expect(fresh.hi - fresh.lo).toBe(SECOND + 300);
    expect(fresh.settled).toBe(false);
    await ensureServerClock(w.ping, w);
    expect(w.calls).toBeGreaterThan(calls + 1);
  });
});

describe("what it is used for", () => {
  it("stamps a placement with the storage's clock, so two devices with different clocks agree", async () => {
    // One device's clock is five minutes ahead of the storage's; the other's is right on it.
    // Each has measured its own offset to within 25 ms.
    await setServerClockState({ ...defaultServerClockState(), samples: 5, lo: -300_025, hi: -299_975 });
    const fastT = Date.UTC(2026, 10, 25, 9, 26, 0);
    vi.spyOn(Date, "now").mockReturnValue(fastT);
    const stampedOnTheFastOne = await serverNow();
    vi.restoreAllMocks();

    await setServerClockState({ ...defaultServerClockState(), samples: 5, lo: -25, hi: 25 });
    vi.spyOn(Date, "now").mockReturnValue(fastT - 300_000); // the same instant, on a true clock
    const stampedOnTheOther = await serverNow();
    vi.restoreAllMocks();

    expect(stampedOnTheFastOne - stampedOnTheOther).toBeLessThanOrEqual(50);
    // Whereby their own clocks are five minutes apart.
    expect(300_000).toBeGreaterThan(50);
  });
});
