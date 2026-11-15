import { describe, expect, it } from "vitest";
import { cacheName, staleCaches, strategyFor } from "./sw-logic";

const origin = "https://table.revah.paris";
const precached = new Set(["/", "/assets/index-abc.js"]);
const s = (path: string, mode: RequestMode = "cors", method = "GET") => strategyFor(new URL(path, origin), method, mode, origin, precached);

describe("service worker routing", () => {
  it("never answers the API or Access from the cache", () => {
    expect(s("/api/state")).toBe("network");
    expect(s("/api/ops", "cors", "POST")).toBe("network");
    expect(s("/api/state", "navigate")).toBe("network");
    expect(s("/cdn-cgi/access/login", "navigate")).toBe("network");
  });

  it("answers a navigation with the cached shell, except the way back through Access", () => {
    expect(s("/", "navigate")).toBe("shell");
    expect(s("/?utm=x", "navigate")).toBe("shell");
    expect(s("/?reconnexion=1", "navigate")).toBe("network");
  });

  it("answers a precached asset from the cache and anything else from the network", () => {
    expect(s("/assets/index-abc.js")).toBe("cache");
    expect(s("/assets/other.js")).toBe("network");
    expect(strategyFor(new URL("https://fonts.example/x.woff2"), "GET", "cors", origin, precached)).toBe("network");
  });

  it("names its cache by version and deletes every older one of its own, nothing else", () => {
    expect(cacheName("abc")).toBe("la-table-abc");
    expect(staleCaches(["la-table-aaa", "la-table-bbb", "other-app"], "la-table-bbb")).toEqual(["la-table-aaa"]);
  });
});
