import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_TOKEN, injectManifest, listFiles, precacheList, swVersion } from "./sw-manifest";

describe("service worker manifest", () => {
  it("precaches the shell at / and every built file but the HTML, the worker and source maps", () => {
    expect(precacheList(["index.html", "sw.js", "assets/index-a.js", "assets/index-a.js.map", "icon.svg", "manifest.webmanifest"])).toEqual([
      "/", "/assets/index-a.js", "/icon.svg", "/manifest.webmanifest",
    ]);
  });

  // a deploy that changes any byte must change the worker, or phones keep the old shell
  it("gives a new version when any served file changes, and the same one whatever the listing order", () => {
    const files = [{ name: "index.html", content: "<html>a</html>" }, { name: "assets/a.js", content: "1" }];
    expect(swVersion([...files].reverse())).toBe(swVersion(files));
    expect(swVersion([{ name: "index.html", content: "<html>b</html>" }, files[1]!])).not.toBe(swVersion(files));
    expect(swVersion([files[0]!, { name: "assets/b.js", content: "1" }])).not.toBe(swVersion(files));
    expect(swVersion(files)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("writes the manifest into the built worker as a string literal, whatever quotes the bundler kept", () => {
    for (const quote of ['"', "'", "`"]) {
      const out = injectManifest(`const m=JSON.parse(${quote}${MANIFEST_TOKEN}${quote});`, { version: "abc", urls: ["/", "/a$&.js"] });
      expect(new Function(out.replace("const m=", "return "))()).toEqual({ version: "abc", urls: ["/", "/a$&.js"] });
    }
    expect(() => injectManifest("no token here", { version: "x", urls: [] })).toThrow(/token/);
  });

  it("lists every file under a directory with forward slashes, sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "la-table-sw-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "b.js"), "b");
    writeFileSync(join(dir, "index.html"), "i");
    expect(listFiles(dir)).toEqual(["assets/b.js", "index.html"]);
  });
});
