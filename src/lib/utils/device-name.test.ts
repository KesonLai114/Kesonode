import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanDeviceLabel, detectDeviceName } from "@/lib/utils/storage";

// The device label is user-facing: it names the device in Settings, and it names the peer
// whose session or extension list you are looking at in the popup. Every case below is a
// real user agent string.

const named = (ua: string): string => {
  vi.stubGlobal("navigator", { userAgent: ua });
  return detectDeviceName();
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("detectDeviceName — the OS half", () => {
  it("does not claim Windows 11 on a Windows 10 machine", () => {
    // Microsoft never bumped the UA token: Windows 10 and Windows 11 BOTH send
    // "Windows NT 10.0". Every Windows 10 user was told they were on 11.
    const win10 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    expect(named(win10)).toBe("Windows 10/11 · Chromium");
  });

  it("recognises Android instead of calling it Linux", () => {
    // A Chromium Android UA carries the "Linux" token, which the desktop branch matched
    // first — so those phones never once identified as Android.
    const androidChromium = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
    expect(named(androidChromium)).toBe("Android · Chromium");

    // Firefox for Android omits "Linux", so this one was already right — keep it covered
    // so the reordering can't break the case that used to work. This is Kesonode's
    // supported Android path.
    const androidFirefox = "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0";
    expect(named(androidFirefox)).toBe("Android · Firefox");
  });

  it("recognises iOS instead of calling it Mac", () => {
    // An iPhone UA contains "Mac OS X", matched by the Mac branch above it.
    // No Safari branch in the browser half, so the label is the bare OS — which is the
    // current behaviour, not an oversight this test is papering over.
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    expect(named(iphone)).toBe("iOS");
  });

  it("still names a real Mac, a real Linux desktop and older Windows", () => {
    expect(named("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"))
      .toBe("Mac · Chromium");
    expect(named("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"))
      .toBe("Linux · Chromium");
    expect(named("Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"))
      .toBe("Windows 7 · Chromium");
  });

  it("calls a Chromium build Chromium, since Chrome's user agent is everyone's", () => {
    // A fresh Helium on Linux sends exactly this, and was named "Linux · Chrome".
    expect(named("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"))
      .toBe("Linux · Chromium");
    expect(named("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"))
      .toBe("Windows 10/11 · Edge");
  });

  it("falls back to a neutral label rather than guessing", () => {
    expect(named("Some/1.0 (unknown platform)")).toBe("Device");
  });
});

describe("cleanDeviceLabel — give the user their own words back", () => {
  it("strips the machine suffixes older builds stored", () => {
    // The reported string, three times over: the field read `Mac · Edge · 451dbeb9`, the
    // owner edited the first word, and the machine half rode along into every restore
    // point name from then on.
    expect(cleanDeviceLabel("Mac · Edge · 451dbeb9")).toBe("Mac");
    expect(cleanDeviceLabel("Macbook · Edge · 451dbeb9")).toBe("Macbook");
    expect(cleanDeviceLabel("Windows 10/11 · Chromium · b5fe8371")).toBe("Windows 10/11");
    expect(cleanDeviceLabel("Android · Firefox · 0a1b2c3d")).toBe("Android");
  });

  it("leaves a name the user chose alone", () => {
    expect(cleanDeviceLabel("Mac mini M4pro")).toBe("Mac mini M4pro");
    expect(cleanDeviceLabel("办公室那台")).toBe("办公室那台");
    expect(cleanDeviceLabel("Mac · Office")).toBe("Mac · Office"); // not a browser token
    // A browser word on its own is the owner's choice, not a leftover: on a machine that
    // runs three browsers, "<machine> · Edge" is the distinguishing half. Stripping it
    // renamed the computer behind the user's back, and restore points are named after it.
    expect(cleanDeviceLabel("Macbook · Edge")).toBe("Macbook · Edge");
    expect(cleanDeviceLabel("Macbook · Chromium")).toBe("Macbook · Chromium");
    expect(cleanDeviceLabel("工作机 · Firefox")).toBe("工作机 · Firefox");
  });

  it("does not eat a date that happens to be all digits", () => {
    // 20240101 is valid hex, so a naive [0-9a-f]{8} rule silently renamed this laptop.
    expect(cleanDeviceLabel("工作机 · 20240101")).toBe("工作机 · 20240101");
    // …unless it IS this device's id, which only a machine would have written.
    expect(cleanDeviceLabel("工作机 · 20240101", "20240101-aaaa-bbbb-cccc-dddddddddddd")).toBe("工作机");
  });

  it("is idempotent and never returns an empty label", () => {
    const once = cleanDeviceLabel("Macbook · Edge · 451dbeb9");
    expect(cleanDeviceLabel(once)).toBe(once);
    expect(cleanDeviceLabel("")).toBe("");
    expect(cleanDeviceLabel(null)).toBe("");
  });
});
