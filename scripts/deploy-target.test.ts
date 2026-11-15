import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_NAME } from "./deploy-config";
import { baseEnv, BUILD_ENV_PINS, buildCall, isExecutable, NPM_CONFIG_PINS, NO_PENDING_MIGRATIONS, SYSTEM_DIRS, SYSTEM_TOOLS, systemTools, WRANGLER_BIN, wranglerPins } from "./deploy-target";

/** A database entry under `name` whose migrations live in `dir`. */
const db = (id: number, dir: string) => ({ binding: "DB", database_name: DATABASE_NAME, database_id: `0b7c3d4e-0000-4000-8000-00000000000${id}`, migrations_dir: dir });

let dir = "";
const config = () => join(dir, "wrangler.jsonc");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "la-table-pins-"));
  const files: Record<string, string> = {
    // the checked configuration: top-level migrations in migrations/, an env.staging naming another database
    "wrangler.jsonc": JSON.stringify({ name: "la-table", compatibility_date: "2026-10-01", d1_databases: [db(1, "migrations")], env: { staging: { d1_databases: [db(2, "staging-migrations")] } } }),
    "migrations/0001_top.sql": "CREATE TABLE top (id INTEGER);\n",
    "staging-migrations/0001_staging.sql": "CREATE TABLE staging (id INTEGER);\n",
    // what wrangler would read without the pins: a .env picking staging (and hiding the banner, so its loading shows),
    // a wrangler.json found before wrangler.jsonc, and a deploy redirect (followed by deploy, never by d1)
    ".env": "CLOUDFLARE_ENV=staging\nWRANGLER_HIDE_BANNER=true\n",
    "wrangler.json": JSON.stringify({ name: "la-table", compatibility_date: "2026-10-01", d1_databases: [db(3, "stray-migrations")] }),
    "stray-migrations/0001_stray.sql": "CREATE TABLE stray (id INTEGER);\n",
    ".wrangler/deploy/config.json": JSON.stringify({ configPath: "../../wrangler.json" }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** `wrangler d1 migrations <command> la-table --local` with these flags, on `state`: local only, nothing reaches Cloudflare. */
function list(pins: string[], state = ".state", command = "list"): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [WRANGLER_BIN, "d1", "migrations", command, DATABASE_NAME, "--local", "--persist-to", join(dir, state), ...pins], {
    cwd: dir,
    env: { ...baseEnv(), WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("wranglerPins, run through the installed wrangler", () => {
  // The deploy's tests stub wrangler, so only this one sees what the flags mean to the wrangler installed: an upgrade
  // that changed them would pass every other test
  it("reads the given configuration at its top level, with no .env loaded, whatever lies beside it", () => {
    const pinned = list(wranglerPins(config()));
    expect(pinned.status).toBe(0);
    expect(pinned.out).toContain("0001_top.sql");
    expect(pinned.out).not.toMatch(/0001_staging|0001_stray/);
    // .env not loaded: its WRANGLER_HIDE_BANNER did not reach wrangler
    expect(pinned.out).toContain("⛅️ wrangler");
  });

  it("controls: each pin removed lets its stray through", () => {
    const without = (flag: string) => wranglerPins(config()).filter((f, i, all) => f !== flag && all[i - 1] !== flag);
    // without --env-file=/dev/null, wrangler loads .env (the banner it hides is gone)
    expect(list(without("--env-file=/dev/null")).out).not.toContain("⛅️ wrangler");
    // without it and without --env=, the .env's CLOUDFLARE_ENV picks env.staging
    expect(list(without("--env-file=/dev/null").filter((f) => f !== "--env=")).out).toContain("0001_staging.sql");
    // without --config, wrangler.json, found first, is read instead
    expect(list(without("--config")).out).toContain("0001_stray.sql");
  });

  it("prints NO_PENDING_MIGRATIONS on a line of its own once every migration is applied, and not before", () => {
    const lines = (out: string) => out.split("\n").map((l) => l.trim());
    expect(lines(list(wranglerPins(config()), ".state-applied").out)).not.toContain(NO_PENDING_MIGRATIONS);
    expect(list(wranglerPins(config()), ".state-applied", "apply").status).toBe(0);
    const after = list(wranglerPins(config()), ".state-applied");
    expect(after.status).toBe(0);
    expect(lines(after.out)).toContain(NO_PENDING_MIGRATIONS);
  });
});

describe("systemTools, where the deploy's git, tar, find and ln come from", () => {
  // Regression: 7a2d5b6 — baseEnv's PATH puts node's own directory first, where `npm i -g` installs every global
  // bin: a package shipping a `git`, `tar`, `find` or `ln` replaced the tools the export's proof relies on
  it("takes each from /usr/bin, then /bin, and from nowhere else, however runnable a path elsewhere is", () => {
    const nodeDir = dirname(process.execPath);
    expect(systemTools((p) => p.startsWith("/usr/bin/") || p.startsWith("/bin/") || p.startsWith(nodeDir))).toEqual({ git: "/usr/bin/git", tar: "/usr/bin/tar", find: "/usr/bin/find", ln: "/usr/bin/ln" });
    expect(systemTools((p) => p.startsWith("/bin/"))).toEqual({ git: "/bin/git", tar: "/bin/tar", find: "/bin/find", ln: "/bin/ln" });
    expect(systemTools((p) => p !== "/usr/bin/find" && p !== "/bin/find")).toBe("find");
    expect(systemTools((p) => p.startsWith(nodeDir) || p.startsWith("/usr/local/bin/"))).toBe("git");
  });

  it("finds all four on this machine, each a runnable file in SYSTEM_DIRS (the control for isExecutable)", () => {
    const tools = systemTools(isExecutable);
    expect(typeof tools).toBe("object");
    for (const tool of SYSTEM_TOOLS) expect((SYSTEM_DIRS as readonly string[]).includes(dirname((tools as Record<string, string>)[tool]!))).toBe(true);
  });

  it("calls runnable only a file this process may run: not a plain file, a directory or a missing path", () => {
    const scratch = mkdtempSync(join(tmpdir(), "la-table-exec-"));
    try {
      writeFileSync(join(scratch, "plain"), "");
      writeFileSync(join(scratch, "tool"), "#!/bin/sh\n");
      chmodSync(join(scratch, "tool"), 0o755);
      mkdirSync(join(scratch, "dir"));
      chmodSync(join(scratch, "dir"), 0o755);
      expect(["tool", "plain", "dir", "missing"].map((n) => isExecutable(join(scratch, n)))).toEqual([true, false, false, false]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("buildCall, run through the installed npm", () => {
  // Regression: bfd00a7 — the build's npm read $HOME/.npmrc and etc/npmrc beside node, outside the commit: a `script-shell`
  // there that ignores its command made `npm run build:ci` exit 0 having run nothing, and a `node-options` loaded code
  // into the typecheck, the tests and the build
  it("reads no user or global npm configuration, in build:ci nor in the npm run it nests", () => {
    const pkg = mkdtempSync(join(tmpdir(), "la-table-npmrc-"));
    try {
      const home = join(pkg, "home");
      mkdirSync(home);
      // a shell that ignores its command, as a user configuration file may name
      writeFileSync(join(home, ".npmrc"), "script-shell=/usr/bin/true\n");
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "x", scripts: { "build:ci": "echo outer-ran && npm run inner", inner: "echo inner-ran" } }));
      const call = buildCall(pkg);
      const run = (env: Record<string, string>) => {
        const r = spawnSync(call.cmd, [...call.args], { cwd: call.cwd, env, encoding: "utf8" });
        return { status: r.status, ran: `${r.stdout}`.split("\n").filter((l) => /^\w+-ran$/.test(l)) };
      };
      // the control: the login's configuration read, the planted shell runs nothing and npm still exits 0
      expect(run({ ...baseEnv(), HOME: home })).toEqual({ status: 0, ran: [] });
      expect(run({ ...call.env, HOME: home })).toEqual({ status: 0, ran: ["outer-ran", "inner-ran"] });
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  // Regression: a2aa2b9 — baseEnv's CI=1 turned colour ON in picocolors (vite) and tinyrainbow (vitest), so the
  // build log a reader searches for `Tests  … passed` carried raw escape codes between the words
  it("turns colour off for vite's and vitest's colour libraries, which CI alone turns on", () => {
    const verdict = (env: Readonly<Record<string, string>>) => {
      const script = 'import pc from "picocolors"; import { isSupported } from "tinyrainbow"; console.log(JSON.stringify([pc.isColorSupported, isSupported()]));';
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dirname(dirname(fileURLToPath(import.meta.url))), env: { ...env }, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as unknown;
    };
    // the control: baseEnv alone, CI set, both libraries print colour into a log that is no terminal
    expect(verdict(baseEnv())).toEqual([true, true]);
    expect(verdict(buildCall("/export/tree").env)).toEqual([false, false]);
  });

  it("runs `npm run build:ci` in the given directory, from baseEnv and BUILD_ENV_PINS only", () => {
    expect(buildCall("/export/tree")).toEqual({ cmd: "npm", args: ["run", "build:ci"], env: { ...baseEnv(), ...BUILD_ENV_PINS }, cwd: "/export/tree" });
    expect(BUILD_ENV_PINS).toEqual({ ...NPM_CONFIG_PINS, NO_COLOR: "1" });
  });
});
