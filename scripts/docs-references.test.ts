import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { textFiles } from "./repo-files.ts";

/**
 * The repository ships without the owner's plans: every « spec §x » (and every bare « §x », which the code uses for the
 * same spec) must name a heading of docs/spec.md, and no file may cite a private plan or its numbering (« Plan <n> »,
 * « decision <n> », « deviation <n> », « fix wave <n> », in any case) or a path under a home folder. Walks the filesystem, never `git ls-files`, so it also runs in a `git archive` export with no `.git`.
 */

/** Section numbers of the spec's headings: « ## 6. Lifecycle » → 6, « ### 6.5 Other… » → 6.5. */
export function specSections(spec: string): Set<string> {
  const sections = new Set<string>();
  for (const m of spec.matchAll(/^#{2,4} (\d+(?:\.\d+)*)\.?\s/gm)) sections.add(m[1]!);
  return sections;
}

// built from parts so that this file does not cite them itself
const PLAN = new RegExp("\\b(plan|decisi" + "on|deviati" + "on|wa" + "ve)\\s+[A-Z]?\\d", "i");
const HOME = new RegExp("(^|[^\\w.$])~" + "/|/Use" + "rs/", "m");

export type Finding = { file: string; line: number; problem: string };

export function findings(root: string): Finding[] {
  const sections = specSections(readFileSync(join(root, "docs", "spec.md"), "utf8"));
  const out: Finding[] = [];
  for (const path of textFiles(root)) {
    const file = relative(root, path).split("\\").join("/");
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, i) => {
        const at = (problem: string) => out.push({ file, line: i + 1, problem });
        for (const m of text.matchAll(/§(\d+(?:\.\d+)*)/g)) if (!sections.has(m[1]!)) at(`§${m[1]} is no heading of docs/spec.md`);
        if (PLAN.test(text)) at("cites a private plan");
        if (HOME.test(text)) at("names a path under a home folder");
      });
  }
  return out;
}

describe("references in shipped files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "la-table-docs-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** A tree holding docs/spec.md and one other file. */
  const tree = (name: string, content: string) => {
    const root = join(scratch, `t${readdirSync(scratch).length}`);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "spec.md"), "# Spec\n\n## 6. Lifecycle\n\n### 6.5 Other operations\n\n## 10. Phone UX\n");
    writeFileSync(join(root, name), content);
    return root;
  };

  it("finds every spec section the repository cites, and no private plan or home path", () => {
    expect(findings(resolve("."))).toEqual([]);
  });

  it("reads the spec's numbered headings", () => {
    expect(specSections(readFileSync(resolve("docs/spec.md"), "utf8"))).toEqual(
      new Set(["1", "2", "3", "4", "4.1", "4.2", "5", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8", "6", "6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "7", "7.1", "7.2", "7.3", "8", "8.1", "8.2", "8.3", "9", "9.1", "9.2", "9.3", "10", "10.1", "10.2", "10.3", "10.4", "10.5", "11", "12", "13"]),
    );
  });

  it("passes a clean control, citations in a list and at a sentence's end included", () => {
    expect(findings(tree("ok.ts", "// spec §6.5, §10 and §6. Then $HOME/.npmrc, a.~/b. The plan's 3 meals, decided 2026-10-20.\n"))).toEqual([]);
  });

  it("reports a section the spec does not have", () => {
    expect(findings(tree("a.ts", "// x\n// spec §6.5, " + "§" + "6.9\n"))).toEqual([{ file: "a.ts", line: 2, problem: "§" + "6.9 is no heading of docs/spec.md" }]);
    expect(findings(tree("b.md", "see " + "§" + "14\n")).map((f) => f.problem)).toEqual(["§" + "14 is no heading of docs/spec.md"]);
  });

  it("reports a private plan and a path under a home folder, on its line", () => {
    expect(findings(tree("c.ts", ["// " + "Plan" + " 3a", "// `~" + "/.claude/plans/x.md`", "/Use" + "rs/someone/x"].join("\n")))).toEqual([
      { file: "c.ts", line: 1, problem: "cites a private plan" },
      { file: "c.ts", line: 2, problem: "names a path under a home folder" },
      { file: "c.ts", line: 3, problem: "names a path under a home folder" },
    ]);
  });

  // Regression: a case-sensitive « Plan <n> » check passed a bare « plan decision N » and « deviation N », in lower case; a « fix wave N » passed in any case
  it("reports a plan's numbering in any case, decisions, deviations and fix waves included", () => {
    const lines = ["// (plan decis" + "ion 22, left to the owner)", "// at most one (Deviati" + "on 6)", "// decision " + "B16: the second cook", "// trims (decisi" + "on D2')", "// PLAN " + "4 task 8", "// decided 2026-10-27, fix wa" + "ve 9"];
    expect(findings(tree("d.ts", lines.join("\n")))).toEqual(lines.map((_, i) => ({ file: "d.ts", line: i + 1, problem: "cites a private plan" })));
  });

  it("walks hidden folders and skips only the build and dependency ones", () => {
    const root = tree("ok.md", "fine\n");
    for (const dir of [".claude/skills/x", "node_modules/x", "dist-demo"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "f.md"), "§" + "99\n");
    }
    expect(findings(root).map((f) => f.file)).toEqual([".claude/skills/x/f.md"]);
  });
});
