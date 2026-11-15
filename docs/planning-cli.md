# Planning CLI

The planning runs in a Claude Code session through the `la-table-planning` project skill (`.claude/skills/la-table-planning/SKILL.md`), which drives this CLI and holds the session protocol. This page is the reference for a human reading what the skill does. The rules and the protocol it applies are designed in [docs/spec.md](spec.md), §5 and §7. Back to the [README](../README.md).

## Commands

```bash
npm run plan -- status [--local]
npm run plan -- check <proposal.json> [--local]
npm run plan -- commit <proposal.json> [--local]
npm run plan -- price <line> <euros> [--local]
npm run plan -- total <trip> <euros> [--local]
npm run plan -- catalogue <products.json> [--local]
npm run plan -- stock <inventory.json> [--local]
npm run plan -- nutrition <products.json> [--local]   # Ciqual values per product, nutrition only; rerun changes nothing
npm run plan -- packs <products.json> [--local]   # pack size and/or reference price per product (a field left out is kept, null clears it), each change printed before → after; rerun changes nothing
npm run plan -- reste <item> <words…> [--low|--pas-low] [--local]   # what is left of a Reste item, in the owners' words (the phone's « Il en reste »); rerun changes nothing
npm run plan -- fini <item>… [--local]   # what the owners say is gone (the phone's « Fini »); an item a meal holds is refused, nothing sent: drop or rebuy is chosen on the phone; rerun changes nothing
npm run plan -- bought <line> <words…> [--oui] [--local]   # what the receipt says a bought line really was (« 1,2 kg », « 4 »), in its unit; its Reste item moves by the difference; over 10 times or under a tenth of the planned quantity needs --oui; rerun changes nothing
npm run plan -- manques [<meal>…] [--local]   # covers what short meals lack (the « Manques » of `status`), free Reste stock first, then Courses; rerun changes nothing
npm run --silent ciqual [-- --dir <folder>] > nutrition.json   # (--silent keeps npm's banner out of the file) data/nutrition-map.json (quantities and `grams_per_piece` are as bought; optional `edible_pct` is the eaten share of the bought weight for g and piece, not ml, default 100, in ]0, 100]) + the Ciqual tables in data/ciqual/ (gitignored) → a file for the line above; exit 1 a map line refused (malformed, or its code absent from the table), 2 could not run: the map not JSON, of the wrong shape or empty, or a table missing or without a record
```

## Rules the CLI applies

A staple (oil, flour, milk…) goes on Courses only when every Reste item of it is « presque fini » or at a known 0; words of unknown quantity still count as some at home, so what is gone is told with `plan -- fini`, never as « 0 » in `plan -- reste`. A staple line taken off Courses « On n'en prend pas » just leaves it, short of nothing; if the staple is still low, the next planning puts it back.

`status` opens with « Restes à préciser », the open items whose quantity is 0 or unknown, each answered with `plan -- reste` in the owners' words, then « Manques », the open meals left short of a product by a declared leftover or by a line taken off Courses « On n'en prend pas » (« comté : 60 g manquent pour … »), each with the free Reste stock of that product (« Reste : 950 g libres »). `plan -- manques` covers them on the owners' go (all, or the meal ids given): a reservation on free Reste stock first, then the spare of a line already on Courses, else a new line in whole packs, printed per meal (« → Reste #46 (réservé) », « → ligne #12 (réserve) », « → nouvelle ligne comté 250 g, 4,35 € »); a meal not short answers « rien ne manque », and an answer not final (exit 2) is safe to re-run.

A loose product enters Reste at the quantity the planning put on Courses (a whole chou blanc as 250 g). From the receipt, `plan -- bought` sets the line to what was bought and moves its Reste item by the same difference, so what a meal already ate stays eaten; it is refused once the item is finished or declared with « Il en reste » (settle the receipts before « Restes à préciser »); a receipt at or below what was already eaten leaves the item of unknown quantity (never a false zero, which would forget what was eaten), which « Restes à préciser » then asks about. The line keeps its price, which stays what the planned quantity cost: a rebuy is priced per unit from that (an unpriced loose line gets `plan -- bought` first, then `plan -- price` for the quantity bought), and calibration reads the extra weight as spend, which it is. A quantity below what other meals hold of the item shrinks their reservations as a declared leftover does, and the meal left short shows under « Manques ».

`check` prints each meal's kcal and protein per portion under its line, « (partiel) » when an ingredient has no values; `status` counts and names the products still without any.

A product's pack size and reference price (`plan -- packs`) round each Courses line up to whole packs, priced from the reference before the proposal's; a meal takes the spare of a line already on Courses after free Reste stock and before a new line, and `check` names what it takes back (« repris sur la liste »); dropping a meal gathers what a line still holds into another line's spare when it all fits there; `status` counts the products still without a reference price.

## Backups and the restore drill

Run `npm run backup` before each planning: it exports the remote D1 into `backups/` (gitignored) and fails with exit `2` if wrangler fails, or if the export lacks a table, an index or a trigger the migrations create (by exact name) or stops mid-statement — the indexes come last in the dump, so a cut export misses one. A dump where a row follows an index fails too, since the cut check relies on that order. The order ops were applied in, which « Annuler » reads to refuse an undo « modifié depuis », is the `applied_ops.seq` column, so a restore or a `VACUUM` that renumbers rowids keeps it, and a trigger refuses any record inserted without one — the export check requires that trigger by name too, so a dump without it fails.

`npm run restore-drill [backup]` restores a backup (the newest in `backups/` by default) into a scratch local D1 (`.wrangler/restore-drill`, wiped first) and checks every table's row count against the dump and every table, index and trigger of the migrations by name: exit `0` restored and verified, `1` the backup is incomplete, does not restore or restores different, `2` could not run.

## Exit codes and the service token

Exit codes: `0` clean, `1` a finding (blocks, an op the server refused and recorded), `2` could not run — including an answer the server did not record (« réponse non définitive »: a version conflict or an internal error): re-run the same command, unchanged. `--local` targets `wrangler dev` on `localhost:8787` with no login. Otherwise the CLI reads the Cloudflare Access service token from the macOS keychain, entries `la-table-access-client-id` and `la-table-access-client-secret`, and sends it only to `DEFAULT_URL`, never to the provisional `replace-me` subdomain: such an address (`DEFAULT_URL` not yet filled), or an `LA_TABLE_URL` that is neither `DEFAULT_URL` nor loopback, exits 2 before any token source is read; an `LA_TABLE_URL` on loopback gets no token and no read.

The token may also come from the environment, variables `LA_TABLE_CLI_ACCESS_CLIENT_ID` and `LA_TABLE_CLI_ACCESS_CLIENT_SECRET` (the CLI's own names, never the build's `LA_TABLE_ACCESS_CLIENT_*`): on macOS only when the keychain read yields neither entry (absent, locked, or a non-GUI session such as ssh or a LaunchAgent; the keychain wins when both hold a token), on any other OS always. Exit 2 when only one of the pair is set, and when only the build's names are set (the message names the CLI's). The probes (`probe:live`, `probe:burst`) and a laptop deploy stay keychain-only, so they need macOS.
