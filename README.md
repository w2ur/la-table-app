# La Table

A private weekly menu and shopping manager for two.

**Status:** in use · private. A web app for two people, used from a phone, behind Cloudflare Access (an email one-time code, limited to the two owners).

The aim is to eat seasonal, fresh food at a reasonable price, with variety. The planning itself happens in a Claude Code session: Claude proposes recipes from the season, the budget, recent meals and what is left at home, then writes the week into the database. The web app is where the lists get read and ticked off, mostly from a phone.

The app is in French and holds three lists:

- **Menu** (the meals) — what we'll eat. Tick a meal once it's cooked.
- **Courses** (the shopping) — what to buy, by aisle, with estimated prices against the weekly budget. A bought item moves into Reste.
- **Reste** (what's left) — what's at home, with use-by dates. Tick an item once it's finished.

## How it works

- Three lists feed each other: buying a Courses item puts it in Reste, finishing it takes it out, and a planned meal reserves what Reste already holds.
- Menu is a rolling pool of meals rather than a fixed weekly grid: cook whichever one suits the day, and the ones with something to use up come first.
- Every change, from the phone or from the planning session, is an operation sent to `POST /api/ops`. The server applies it, records it, and can undo it. Nothing rewrites a whole list.
- The product catalogue (seasons, shelf lives) lives in `data/products.seed.json`; `npm run seed:sql` regenerates the first-catalogue migration from it; products added later go through `npm run plan -- catalogue`.

## Before each planning

1. `npm run backup` exports the remote database into `backups/` (gitignored). Exit `2` means no usable backup: do not plan.
2. In Claude Code, ask for a planning: the `la-table-planning` skill runs the session, starting with `npm run plan -- status` (receipts to settle, leftovers to describe, meals left short).
3. Now and then, `npm run restore-drill` restores the newest backup into a scratch local database and checks it.

The planning CLI, the backup and the restore drill share one exit convention: `0` clean, `1` a finding, `2` could not run. On a CLI answer marked « réponse non définitive » (exit `2`), re-run the same command, unchanged. The CLI reads its Cloudflare Access service token from the macOS login keychain, entries `la-table-access-client-id` and `la-table-access-client-secret`; on another OS, or on macOS when the keychain read yields neither entry (absent, locked, or a non-GUI session such as ssh or a LaunchAgent), from the environment variables `LA_TABLE_CLI_ACCESS_CLIENT_ID` and `LA_TABLE_CLI_ACCESS_CLIENT_SECRET` (set both; the build's `LA_TABLE_ACCESS_CLIENT_*` are another token's and never used: set alone, they exit 2 naming the CLI's); `--local` targets `wrangler dev` instead, with no token.

## Stack

- Cloudflare Worker (TypeScript): JSON API and static assets
- Cloudflare D1 (SQLite)
- Vite + Preact + TypeScript, as an installable PWA
- Vitest
- Cloudflare Access for login (email one-time code)

## Run locally

Requires Node 24.

```bash
npm install
npm run dev
```

`npm test` runs the suite, `npm run typecheck` type-checks it, `npm run build` builds the front end, and `npm run build:demo` builds the static demo into `dist-demo/`: the same app on invented data, its server running in the browser, with no account and no network. `npm run e2e` drives the phone app in Chromium against a fresh local Worker and database (once: `npx playwright install chromium`).

## Deploy

Workers Builds runs `npm run deploy:ci` on every push to `main`, on the Cloudflare Workers free tier. It type-checks, tests and builds an export of the pushed commit, never the working tree, checks that Cloudflare Access guards the address before and after, applies the pending D1 migrations, deploys, and waits until that commit answers behind Access. `npm run deploy` runs the same gate from a laptop, for a clean tree at GitHub's `main` only. Never `wrangler deploy` by hand. The static demo is a separate assets-only Worker, `la-table-demo`, deployed by `npm run deploy:demo` from its own Workers Builds entry ([docs/deploy.md](docs/deploy.md)).

## Documentation

- [docs/phone-app.md](docs/phone-app.md) — what each screen does, with a glossary of the French labels, and what happens when both phones act at once.
- [docs/planning-cli.md](docs/planning-cli.md) — every `npm run plan --` command, the rules it applies, backups, the restore drill and exit codes.
- [docs/deploy.md](docs/deploy.md) — each step of the deploy gate and what it refuses.
- [docs/spec.md](docs/spec.md) — the design specification the code cites as « spec §x »: data model, rules, operations, sync, phone UX.
- [SELF-HOSTING.md](SELF-HOSTING.md) — running your own copy on your own Cloudflare account: the values to replace, the database, Access and its two service tokens, the Workers Builds entries, backups, updates from this mirror (English and French).
- [SELF-HOSTING-BEGINNER.md](SELF-HOSTING-BEGINNER.md) — the same, step by step, for someone who has never used a terminal or GitHub: every click in the Cloudflare and GitHub dashboards, how to check each step, what each error means, and a planning session on a Mac (English and French).
- [.claude/skills/la-table-planning/SKILL.md](.claude/skills/la-table-planning/SKILL.md) and [.claude/skills/la-table-deploy/SKILL.md](.claude/skills/la-table-deploy/SKILL.md) — the rules an agent follows when planning and when deploying; [DESIGN.md](DESIGN.md) — the visual direction.

---

Made with care by [William](https://william.revah.paris)
