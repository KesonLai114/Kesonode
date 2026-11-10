import { describe, it, expect, beforeEach } from "vitest";
import { readPeerLabels, rememberPeerLabels } from "@/lib/utils/peer-labels";

const KEY = "kesonode_peer_labels";

describe("peer device-name cache", () => {
  beforeEach(async () => {
    await chrome.storage.local.remove(KEY);
  });

  it("learns a name from a packet and reads it back", async () => {
    expect(await readPeerLabels()).toEqual({});
    await rememberPeerLabels([{ device_id: "a", device_label: "Mac mini M4pro" }]);
    expect((await readPeerLabels())["a"].label).toBe("Mac mini M4pro");
  });

  it("a newer name wins, and a blank name never erases a good one", async () => {
    await rememberPeerLabels([{ device_id: "a", device_label: "Old" }]);
    await rememberPeerLabels([{ device_id: "a", device_label: "New" }]);
    await rememberPeerLabels([{ device_id: "a", device_label: "" }, { device_id: "a" }]);
    expect((await readPeerLabels())["a"].label).toBe("New");
  });

  it("ignores packets without an id and trims whitespace", async () => {
    await rememberPeerLabels([
      { device_label: "No id" },
      { device_id: "b", device_label: "  Laptop  " },
    ]);
    const all = await readPeerLabels();
    expect(all["b"].label).toBe("Laptop");
    expect(Object.keys(all)).toEqual(["b"]);
  });

  it("keeps the cache bounded", async () => {
    const packets = Array.from({ length: 70 }, (_, i) => ({
      device_id: `d${i}`, device_label: `Device ${i}`,
    }));
    await rememberPeerLabels(packets);
    expect(Object.keys(await readPeerLabels())).toHaveLength(64);
  });

  it("survives a corrupt cache without losing the ability to learn", async () => {
    await chrome.storage.local.set({ [KEY]: "not an object" });
    expect(await readPeerLabels()).toEqual({});
    await rememberPeerLabels([{ device_id: "c", device_label: "Recovered" }]);
    expect((await readPeerLabels())["c"].label).toBe("Recovered");
  });
});
