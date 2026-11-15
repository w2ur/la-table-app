import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dangling } from "./check-export-links.ts";

describe("dangling links in a tree's Markdown", () => {
  const scratch = mkdtempSync(join(tmpdir(), "la-table-links-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let n = 0;
  /** A tree of the given files (path → content). */
  const tree = (files: Record<string, string>) => {
    const root = join(scratch, `t${n++}`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it("accepts links and backticked paths that resolve, URLs, anchors and build output", () => {
    const root = tree({
      "README.md": "[guide](docs/a.md#top) [web](https://example.org/x.md) [here](#h) `src/x.ts` `dist/app.js` `src/app/**` `npm run build`\n",
      "docs/a.md": "[up](../README.md) `docs/a.md`\n",
      "src/x.ts": "",
    });
    expect(dangling(root)).toEqual([]);
  });

  // Control: each check must fail on a fixture that holds a dangling reference, or a silent pass proves nothing.
  it("reports a link to a file the tree does not hold, with its line", () => {
    const root = tree({ "README.md": "ok\n[owner notes](CLAUDE.md)\n" });
    expect(dangling(root)).toEqual([{ file: "README.md", line: 2, target: "CLAUDE.md" }]);
  });

  it("reports a relative link that climbs to a missing file", () => {
    const root = tree({ "docs/a.md": "[x](../gone.md)\n" });
    expect(dangling(root)).toEqual([{ file: "docs/a.md", line: 1, target: "../gone.md" }]);
  });

  it("reports a backticked repository path and a backticked root file that are absent", () => {
    const root = tree({ "README.md": "see `src/missing.ts` and `CLAUDE.md`\n", "src/x.ts": "" });
    expect(dangling(root).map((d) => d.target)).toEqual(["src/missing.ts", "CLAUDE.md"]);
  });

  // Regression: docs/spec.md shipped « triggered by a line in the repo's CLAUDE.md », a bare name in prose that neither
  // the link nor the backtick check saw, so the export of a tree with no CLAUDE.md printed « links: clean ».
  it("reports a bare Markdown name in prose that names no file in the tree", () => {
    const root = tree({ "docs/spec.md": "x\ntriggered by a line in the repo's CLAUDE.md (\"Planning\").\n" });
    expect(dangling(root)).toEqual([{ file: "docs/spec.md", line: 2, target: "CLAUDE.md" }]);
  });

  it("accepts a bare Markdown name that some file in the tree holds, and reports a dangling link once", () => {
    const root = tree({
      "README.md": "See DESIGN.md, each SKILL.md, and [CLAUDE.md](CLAUDE.md).\n",
      "DESIGN.md": "",
      ".claude/skills/a/SKILL.md": "",
    });
    expect(dangling(root)).toEqual([{ file: "README.md", line: 1, target: "CLAUDE.md" }]);
  });

  // Regression (Task 4 review, round 2): a backticked path into a folder the export lacks entirely, a lowercase root
  // file and a reference-style definition each printed « links: clean ».
  it("reports a backticked path into a folder or root file the export left out, from the private tree's names", () => {
    const root = tree({ "README.md": "`.github/workflows/pr-gate.yml` `wrangler.prod.jsonc` `scripts/gone.sh` `~" + "/.claude/x` `../x`\n", "scripts/x.ts": "" });
    const privateTop = new Set([".github", "wrangler.prod.jsonc", "scripts", "README.md"]);
    expect(dangling(root, privateTop).map((d) => d.target)).toEqual([".github/workflows/pr-gate.yml", "wrangler.prod.jsonc", "scripts/gone.sh"]);
    // Without the private tree's names, a dot-folder path is still checked; a lowercase root file is not.
    expect(dangling(root).map((d) => d.target)).toEqual([".github/workflows/pr-gate.yml", "scripts/gone.sh"]);
  });

  it("reads a reference-style definition as a link, and accepts one that resolves or is a URL", () => {
    const root = tree({
      "README.md": "See [the notes][ref].\n\n[ref]: docs/gone.md\n  [ok]: <docs/a.md#top>\n[web]: https://example.org/CLAUDE.md\n",
      "docs/a.md": "",
    });
    expect(dangling(root)).toEqual([{ file: "README.md", line: 3, target: "docs/gone.md" }]);
  });

  // Regression (Task 4 review, round 3): an inline link with a title never matched the link pattern, and the prose pass
  // then removed the whole span, so `[notes](CLAUDE.md "owner notes")` printed « links: clean »; an HTML `<a href>` was
  // not read at all.
  it("reports a titled inline link and an HTML link to a missing file, and accepts ones that resolve", () => {
    const root = tree({
      "README.md": `See [notes](CLAUDE.md "owner notes") and [pub](<../scripts/gone.sh> 'x') and <a href="docs/gone.md">g</a>.\n[ok](docs/a.md "t") <a class="x" href='docs/a.md#top'>ok</a> <a href="https://example.org/CLAUDE.md">w</a>\n`,
      "docs/a.md": "",
    });
    expect(dangling(root).map((d) => d.target)).toEqual(["CLAUDE.md", "../scripts/gone.sh", "docs/gone.md"]);
  });

  // Regression (Task 4 review, round 3): a backticked bare name was looked up at the root only, so `SKILL.md` was
  // reported although .claude/skills/*/SKILL.md exist; the same name in prose counted as present.
  it("accepts a backticked bare name some file in the tree holds, unless the private root names it", () => {
    const root = tree({ "README.md": "each `SKILL.md`, and `CLAUDE.md`\n", ".claude/skills/a/SKILL.md": "", "docs/CLAUDE.md": "" });
    expect(dangling(root)).toEqual([]);
    // Control: a root file of the private tree is looked up at the export's root, not anywhere.
    expect(dangling(root, new Set(["CLAUDE.md"])).map((d) => d.target)).toEqual(["CLAUDE.md"]);
    // Control: a name no file in the tree holds is still reported.
    expect(dangling(tree({ "README.md": "`SKILL.md`\n" })).map((d) => d.target)).toEqual(["SKILL.md"]);
  });
});

describe("the command", () => {
  const scratch = mkdtempSync(join(tmpdir(), "la-table-links-cli-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const SCRIPT = resolve("scripts/check-export-links.ts");
  const run = (script: string, dir: string) => spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  const dirty = join(scratch, "dirty");
  mkdirSync(dirty);
  writeFileSync(join(dirty, "README.md"), "[notes](CLAUDE.md)\n");

  it("reports a dangling link with exit 1", () => {
    const r = run(SCRIPT, dirty);
    expect(r.stdout, r.stderr).toContain("links: 1 dangling");
    expect(r.status).toBe(1);
  });

  // Regression: e9f93f1 — the main ran on a string compare of import.meta.url with argv[1], so a run through a
  // symlink (node resolves the main module's real path) did nothing and exited 0 on a tree with a dangling link.
  it("runs, and finds the dangling link, when started through a symlink", () => {
    const link = join(scratch, "linked-check.ts");
    symlinkSync(SCRIPT, link);
    const r = run(link, dirty);
    expect(r.stdout, r.stderr).toContain("links: 1 dangling");
    expect(r.status).toBe(1);
  });

  // Regression: 9f8fe8f — a missing export folder threw out of statSync, and node exits 1 on an uncaught error: « could
  // not run » read as a finding. Exit convention: 0 clean, 1 a finding, 2 could not run.
  it("exits 2 when the folder is missing or is a file", () => {
    for (const dir of [join(scratch, "missing"), join(dirty, "README.md")]) {
      const r = run(SCRIPT, dir);
      expect(r.stderr, dir).toContain("links: could not run");
      expect(r.status, dir).toBe(2);
    }
  });

  it("control: a clean folder exits 0", () => {
    const clean = join(scratch, "clean");
    mkdirSync(clean);
    writeFileSync(join(clean, "README.md"), "nothing to see\n");
    const r = run(SCRIPT, clean);
    expect(r.stdout, r.stderr).toContain("links: clean");
    expect(r.status).toBe(0);
  });
});
