import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isEntry } from "./entry";

const dir = mkdtempSync(join(tmpdir(), "la-table-entry-"));
const real = join(dir, "script.ts");
writeFileSync(real, "");
symlinkSync(dir, join(dir, "link"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isEntry", () => {
  // Regression: 0dcde21 — the guard compared process.argv[1] as typed with the module's real path: a script run
  // through a symlink (or with another letter case on macOS) did nothing and exited 0, a deploy that never ran
  it("is true for the module's own path however it was typed: as is, through a symlink, in another letter case", () => {
    const url = pathToFileURL(real).href;
    expect(isEntry(url, real)).toBe(true);
    expect(isEntry(url, join(dir, "link", "script.ts"))).toBe(true);
    if (process.platform === "darwin") expect(isEntry(url, real.replace("script.ts", "SCRIPT.ts"))).toBe(true);
  });

  it("is false for another file, a missing one, or no argument at all", () => {
    const url = pathToFileURL(real).href;
    writeFileSync(join(dir, "other.ts"), "");
    expect(isEntry(url, join(dir, "other.ts"))).toBe(false);
    expect(isEntry(url, join(dir, "missing.ts"))).toBe(false);
    expect(isEntry(url, undefined)).toBe(false);
  });
});
