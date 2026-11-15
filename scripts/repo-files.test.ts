import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { publisherExcluded, repoFiles, SKIP_PUBLISHER, textFiles } from "./repo-files.ts";

const scratch = mkdtempSync(join(tmpdir(), "la-table-repo-files-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
/** A tree of the given files (path → content). */
function tree(files: Record<string, string | Buffer>): string {
  const root = join(scratch, `t${n++}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const rel = (root: string, paths: Iterable<string>) => [...paths].map((p) => relative(root, p)).sort();

describe("what the publisher always excludes", () => {
  // Regression: 32064be — SKIP_FILES re-typed the publisher's list by hand and missed scripts/publish-public.d.
  it("is read from the publisher, its .d folder and the conf's allowlist included", () => {
    expect([...SKIP_PUBLISHER].sort()).toEqual([
      "scripts/publish-binaries.allow",
      "scripts/publish-public.conf",
      "scripts/publish-public.d",
      "scripts/publish-public.sh",
      "scripts/publish-public.test.sh",
    ]);
  });

  it("is empty in a tree without the publisher (the public mirror holds none of it)", () => {
    expect(publisherExcluded(tree({ "README.md": "" }))).toEqual(new Set());
  });

  it("control: a publisher whose block cannot be read throws, rather than skip nothing", () => {
    const root = tree({ "scripts/publish-public.sh": "#!/bin/sh\nEXCLUDES=()\n", "scripts/publish-public.conf": "binary-allowlist x\n" });
    expect(() => publisherExcluded(root)).toThrow("EXCLUDES");
  });

  it("the walker skips each of them, a file in the .d folder included, and keeps the rest", () => {
    const root = tree({
      "scripts/publish-public.sh": "",
      "scripts/publish-public.d/hook.sh": "",
      "scripts/publish-binaries.allow": "",
      "scripts/other.sh": "",
      "README.md": "",
      "node_modules/x/index.js": "",
      ".claude/agent-memory/a.md": "",
      "logo.png": Buffer.from([0x89, 0x50, 0x00, 0x47]),
    });
    expect(rel(root, repoFiles(root))).toEqual(["README.md", "logo.png", "scripts/other.sh"]);
    expect(rel(root, textFiles(root))).toEqual(["README.md", "scripts/other.sh"]);
  });
});
