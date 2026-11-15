import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { textFiles } from "./repo-files.ts";

/**
 * Nothing but the planning CLI takes its token from the environment: only `src/cli/plan.ts` passes `clientConfig` a
 * `fallback`. The other readers (the probes, the CI deploy) make their real calls in entry blocks no test runs, so this
 * reads the source of every shipped code file that names `clientConfig`, `readKeychain` or one of the CLI's environment
 * names (FORBIDDEN), found by walking the tree rather than listed by hand, so a new reader is checked the day it lands.
 */
/** The one caller allowed a fallback, and the module that defines `clientConfig`, its fallback and the CLI's variables. */
const EXEMPT = new Set(["src/cli/plan.ts", "src/cli/client.ts"]);
const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/; // tests build their own configs and never run against the service
/** Names only the CLI and its client module may spell: the CLI's variables, its fallback type, an aliased import. */
const FORBIDDEN = ["CLI_ID_VAR", "CLI_SECRET_VAR", "LA_TABLE_CLI_ACCESS_CLIENT", "TokenFallback", "clientConfig as"] as const;

/** Every shipped, non-test code file under `root` that names a token reader or a FORBIDDEN name, as repository-relative paths. */
function tokenReaders(root: string): string[] {
  const out: string[] = [];
  for (const path of textFiles(root)) {
    const file = relative(root, path).split("\\").join("/");
    if (!CODE.test(file) || TEST.test(file) || EXEMPT.has(file)) continue;
    const source = readFileSync(path, "utf8");
    if (/\b(clientConfig|readKeychain)\b/.test(source) || FORBIDDEN.some((name) => source.includes(name))) out.push(file);
  }
  return out.sort();
}

/** Each token reader under `root` with why it could read the CLI's environment token; a file naming `clientConfig` must call it. */
function treeViolations(root: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const file of tokenReaders(root)) {
    const source = readFileSync(join(root, file), "utf8");
    const why = keychainOnlyViolations(source, /\bclientConfig\b/.test(source));
    if (why.length > 0) out[file] = why;
  }
  return out;
}

/** The argument text of every `clientConfig(...)` call in `source`, parentheses balanced. */
function clientConfigCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /\bclientConfig\s*\(/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    calls.push(source.slice(start, i - 1).trim());
  }
  return calls;
}

/** `source` without its comments and its `import { … } from "…"` statements: what is left can only use a name, not declare or explain it. */
function codeOutsideImports(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\bimport\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']*["']\s*;?/g, "")
    .split("\n");
}

/** Why `source` could read the CLI's environment token, or [] when it cannot; `mustCall` requires at least one call. */
function keychainOnlyViolations(source: string, mustCall: boolean): string[] {
  const out: string[] = FORBIDDEN.filter((name) => source.includes(name)).map((name) => `names ${name}`);
  // a bare reference (an alias, an argument, a re-export) could be called later with a fallback this check never sees
  for (const line of codeOutsideImports(source)) {
    if (/\bclientConfig\b(?!\s*\()/.test(line)) out.push(`uses clientConfig without calling it: ${line.trim()}`);
  }
  const calls = clientConfigCalls(source);
  if (mustCall && calls.length === 0) out.push("no clientConfig( call found: the check would pass on nothing");
  for (const arg of calls) {
    // an inline literal only: a variable or a spread could carry a `fallback` this check cannot see
    if (!arg.startsWith("{")) out.push(`clientConfig(${arg}) is not an inline object`);
    if (arg.includes("...")) out.push(`clientConfig(${arg}) spreads an object`);
    if (/\bfallback\b/.test(arg)) out.push(`clientConfig(${arg}) passes fallback`);
  }
  return out;
}

const KEYCHAIN_CALL = "cfg = clientConfig({ local: false, env: process.env, readSecret: readKeychain });";

describe("keychain-only token readers", () => {
  const scratch = mkdtempSync(join(tmpdir(), "la-table-keychain-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  let trees = 0;
  /** A tree holding `files`, path → source. */
  const tree = (files: Record<string, string>) => {
    const root = join(scratch, `t${trees++}`);
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    return root;
  };

  it("no shipped token reader but the CLI can read the environment", () => {
    expect(treeViolations(resolve("."))).toEqual({});
  });

  it("finds the probes and the CI deploy without being told", () => {
    expect(tokenReaders(resolve("."))).toEqual(expect.arrayContaining(["scripts/deploy-ci.ts", "scripts/probe-burst.ts", "scripts/probe-live.ts"]));
  });

  // Regression: the readers were a hand-typed list of the two probes, so a new scripts/probe-zz.ts passing `fallback` left the suite green
  it("reports a new reader passing a fallback, and exempts only the CLI, its client module and tests", () => {
    const fallback = "cfg = clientConfig({ local: false, env: process.env, readSecret: readKeychain, fallback: { platform: process.platform, env: process.env } });";
    const root = tree({
      "scripts/probe-zz.ts": fallback,
      "tools/deep/reader.mts": `const id = process.env.LA_TABLE_CLI_ACCESS_CLIENT_ID; readKeychain("x");`,
      "scripts/ok.ts": KEYCHAIN_CALL,
      "src/cli/plan.ts": fallback,
      "src/cli/client.ts": "export function clientConfig(opts: { fallback?: TokenFallback }) {}",
      "src/cli/x.test.ts": fallback,
      "node_modules/m/index.ts": fallback,
      "docs/notes.md": fallback,
    });
    expect(tokenReaders(root)).toEqual(["scripts/ok.ts", "scripts/probe-zz.ts", "tools/deep/reader.mts"]);
    expect(Object.keys(treeViolations(root))).toEqual(["scripts/probe-zz.ts", "tools/deep/reader.mts"]);
  });

  // Regression: only files naming clientConfig or readKeychain were read, so a script sending process.env.LA_TABLE_CLI_ACCESS_CLIENT_*
  // as Access headers, or an alias of clientConfig after one legal call, left the suite green
  it("reads every file naming a forbidden name, and reports an alias of clientConfig", () => {
    const direct = `const h = { "CF-Access-Client-Id": process.env.LA_TABLE_CLI_ACCESS_CLIENT_ID ?? "", "CF-Access-Client-Secret": process.env.LA_TABLE_CLI_ACCESS_CLIENT_SECRET ?? "" };\nawait fetch(DEFAULT_URL, { headers: h });`;
    const alias = `${KEYCHAIN_CALL}\nconst make = clientConfig;\nmake({ local: false, env: process.env, readSecret: readKeychain, fallback: { platform: process.platform, env: process.env } });`;
    const inline = "cfg = clientConfig({ local: false, env: process.env, readSecret: readKeychain, fallback: { platform: process.platform, env: process.env } });";
    const root = tree({ "scripts/probe-direct.ts": direct, "scripts/probe-alias.ts": alias, "scripts/probe-inline.ts": inline, "scripts/ok.ts": KEYCHAIN_CALL });
    expect(tokenReaders(root)).toEqual(["scripts/ok.ts", "scripts/probe-alias.ts", "scripts/probe-direct.ts", "scripts/probe-inline.ts"]);
    expect(Object.keys(treeViolations(root))).toEqual(["scripts/probe-alias.ts", "scripts/probe-direct.ts", "scripts/probe-inline.ts"]);
  });

  // controls: each shape that would make a probe read LA_TABLE_CLI_ACCESS_CLIENT_* is reported
  it("passes the probes' own call shape", () => {
    expect(keychainOnlyViolations(KEYCHAIN_CALL, true)).toEqual([]);
  });

  // strings are left in, so a string naming clientConfig is reported: no shipped file has one
  it("passes imports and comments that name clientConfig without using it", () => {
    const source = `import { CliError, clientConfig, DEFAULT_URL } from "../src/cli/client.ts";\nimport type {\n  clientConfig,\n} from "../src/cli/client.ts";\n/** \`clientConfig\` already refuses everything but DEFAULT_URL */\n// clientConfig is the only door\n${KEYCHAIN_CALL}`;
    expect(keychainOnlyViolations(source, true)).toEqual([]);
  });

  it.each([
    ["a fallback", "cfg = clientConfig({ local: false, env: process.env, readSecret: readKeychain, fallback: { platform: process.platform, env: process.env } });"],
    ["a fallback on its own line", "cfg = clientConfig({\n  local: false,\n  env: process.env,\n  readSecret: readKeychain,\n  fallback: fb(),\n});"],
    ["a spread", "cfg = clientConfig({ ...opts, readSecret: readKeychain });"],
    ["a variable", "cfg = clientConfig(opts);"],
    ["an aliased import", `import { clientConfig as cc } from "../src/cli/client.ts";\n${KEYCHAIN_CALL}`],
    ["the CLI's variable names", `${KEYCHAIN_CALL}\nconst id = process.env[CLI_ID_VAR];`],
    ["the CLI's variable spelled out", `${KEYCHAIN_CALL}\nconst id = process.env.LA_TABLE_CLI_ACCESS_CLIENT_ID;`],
    ["no call at all", "const cfg = makeConfig();"],
    // Regression: an alias was never seen, so one legal call followed by `const make = clientConfig; make({ fallback })` passed
    ["an alias of clientConfig", `${KEYCHAIN_CALL}\nconst make = clientConfig;\nmake({ local: false, env: process.env, readSecret: readKeychain, fallback: { platform: process.platform, env: process.env } });`],
    ["clientConfig passed as a value", `${KEYCHAIN_CALL}\nrun(clientConfig);`],
  ])("reports %s", (_label, source) => {
    expect(keychainOnlyViolations(source, true)).not.toEqual([]);
  });
});
