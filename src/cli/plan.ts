import { readFileSync, writeFileSync } from "node:fs";
import { boughtText } from "./bought";
import { catalogueText } from "./catalogue";
import { checkText } from "./check";
import { CliError, clientConfig, fetchState, postOp, type FetchLike, type SecretReader } from "./client";
import { commitText, type CommitJournal } from "./commit";
import { isEntry } from "./entry";
import { parseEuros } from "./format";
import { readKeychain } from "./keychain";
import { manquesText } from "./manques";
import { nutritionText } from "./nutrition";
import { packsText } from "./packs";
import { finiText } from "./fini";
import { resteText } from "./reste";
import { renderStatus } from "./status";
import { stockText } from "./stock";

export interface CliDeps {
  fetch: FetchLike;
  readSecret: SecretReader;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  now: () => string;
  env: Record<string, string | undefined>;
  /** `process.platform`: with `env`, the token's second source (`LA_TABLE_CLI_ACCESS_CLIENT_ID` / `_SECRET`) outside macOS and when the keychain is empty. */
  platform: string;
  /** The app's address when not DEFAULT_URL (tests, until the deploy setup fills it). */
  defaultUrl?: string;
  out: (s: string) => void;
  err: (s: string) => void;
  uuid: () => string;
}

const USAGE = `usage : npm run plan -- <commande> [--local]
  status                     état pour la planification
  check <proposal.json>      vérifie une proposition (0 propre · 1 blocages · 2 impossible)
  commit <proposal.json>     vérifie puis enregistre la planification
  price <ligne> <euros>      chiffre une ligne (ex. price 12 3,50)
  total <passage> <euros>    saisit le total d'un ticket
  catalogue <produits.json>  ajoute ou met à jour des produits du catalogue (relance sans effet)
  stock <inventaire.json>    ajoute au Reste ce qui est déjà à la maison (relance sans doublon)
  nutrition <produits.json>  pose les valeurs Ciqual de produits du catalogue (relance sans effet)
  packs <produits.json>      pose paquets et prix de référence de produits du catalogue (relance sans effet)
  manques [<repas>…]         couvre ce qui manque à des repas : le Reste libre d'abord, puis Courses (relance sans effet)
  reste <article> <mots…> [--low|--pas-low]
                             ce qu'il reste d'un article du Reste, dans les mots du propriétaire (relance sans effet)
  fini <article>…            ce que le propriétaire dit épuisé : l'article sort du Reste (relance sans effet)
  bought <ligne> <mots…> [--oui]
                             ce que le ticket dit d'une ligne achetée (ex. bought 46 1,2 kg) ; --oui au-delà de 10 fois la quantité prévue (relance sans effet)`;

class Usage extends Error {}
const id = (s: string | undefined): number => {
  if (!s || !/^\d{1,9}$/.test(s)) throw new Usage(`identifiant entier attendu : ${s ?? "(absent)"}`);
  return Number(s);
};
const cents = (s: string | undefined): number => {
  const c = s === undefined ? null : parseEuros(s);
  if (c === null) throw new Usage(`montant en euros attendu (ex. 3,50) : ${s ?? "(absent)"}`);
  return c;
};

const receiptCents = (s: string | undefined): number => {
  const c = cents(s);
  if (c === 0) throw new Usage(`un total de 0 € n'est pas un ticket : ${s}`);
  return c;
};

/** `<proposal>.envois.json`, next to the proposal in the session scratchpad: the op id sent per proposal content. */
export function fileJournal(proposalPath: string, deps: Pick<CliDeps, "readFile" | "writeFile">): CommitJournal {
  const path = `${proposalPath}.envois.json`;
  const unreadable = (): CliError => new CliError(`journal ${path} illisible, vérifier avant de renvoyer`, 2);
  const load = (): Record<string, string> => {
    let raw: string;
    try {
      raw = deps.readFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw unreadable();
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw unreadable(); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw unreadable();
    const entries = parsed as Record<string, unknown>;
    if (!Object.values(entries).every((v) => typeof v === "string")) throw unreadable();
    return entries as Record<string, string>;
  };
  const save = (entries: Record<string, string>, consequence: string): void => {
    try {
      deps.writeFile(path, JSON.stringify(entries));
    } catch (error) {
      throw new CliError(`écriture de ${path} impossible, ${consequence} : ${error instanceof Error ? error.message : String(error)}`, 2);
    }
  };
  return {
    get: (key) => load()[key] ?? null,
    set: (key, opId) => save({ ...load(), [key]: opId }, "rien n'est envoyé"),
    // after the server's final answer: the entry stays, so the same command replays that answer
    delete: (key) => {
      const { [key]: _gone, ...rest } = load();
      save(rest, "la réponse du serveur est arrivée, relancez la même commande pour la lire");
    },
  };
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const local = argv.includes("--local");
  const [command, ...rest] = argv.filter((a) => a !== "--local");
  const lowFlags = command === "reste" ? rest.filter((a) => a === "--low" || a === "--pas-low") : [];
  const confirmed = command === "bought" && rest.includes("--oui");
  const args = command === "reste" ? rest.filter((a) => a !== "--low" && a !== "--pas-low") : command === "bought" ? rest.filter((a) => a !== "--oui") : rest;
  try {
    const needsFile = command === "check" || command === "commit" || command === "stock" || command === "catalogue" || command === "nutrition" || command === "packs";
    if (!["status", "check", "commit", "catalogue", "stock", "nutrition", "packs", "reste", "fini", "bought", "manques", "price", "total"].includes(command ?? "")) throw new Usage(command ? `commande inconnue : ${command}` : "commande manquante");
    const arity = { status: 0, check: 1, commit: 1, catalogue: 1, stock: 1, nutrition: 1, packs: 1, reste: Infinity, fini: Infinity, bought: Infinity, manques: Infinity, price: 2, total: 2 }[command as string]!;
    if (args.length > arity) throw new Usage(`argument en trop : ${args.slice(arity).join(" ")}`);
    if (needsFile && !args[0]) throw new Usage(command === "stock" ? "fichier d'inventaire manquant" : command === "catalogue" || command === "nutrition" || command === "packs" ? "fichier de produits manquant" : "fichier de proposition manquant");
    if (command === "reste") {
      if (new Set(lowFlags).size > 1) throw new Usage("--low et --pas-low ensemble");
      if (args.length < 2) throw new Usage(args.length === 0 ? "article manquant" : "mots manquants (ce qu'il reste)");
      id(args[0]); // before the keychain is read, as price and total check theirs
    }
    if (command === "bought") {
      if (args.length < 2) throw new Usage(args.length === 0 ? "ligne manquante" : "mots manquants (la quantité du ticket)");
      id(args[0]); // before the keychain is read, as for reste
    }
    const mealIds = command === "manques" ? args.map(id) : []; // before the keychain is read, as for reste
    if (command === "fini" && args.length === 0) throw new Usage("article manquant");
    const itemIds = command === "fini" ? args.map(id) : []; // before the keychain is read, as for reste
    const write = command === "price" ? { type: "shopping.set_price", payload: { itemId: id(args[0]), estPriceCents: cents(args[1]) } }
      : command === "total" ? { type: "trip.set_total", payload: { tripId: id(args[0]), totalCents: receiptCents(args[1]) } }
      : null;
    let text = "";
    if (needsFile) {
      try { text = deps.readFile(args[0]!); } catch (e) { throw new CliError(`lecture de ${args[0]} impossible : ${e instanceof Error ? e.message : String(e)}`, 2); }
    }
    const cfg = clientConfig({ local, env: deps.env, readSecret: deps.readSecret, defaultUrl: deps.defaultUrl, fallback: { platform: deps.platform, env: deps.env } });

    if (command === "status") { deps.out(renderStatus(await fetchState(cfg, deps.fetch), deps.now())); return 0; }
    if (command === "check") {
      const r = checkText(text, await fetchState(cfg, deps.fetch), deps.now());
      deps.out(r.output);
      return r.exitCode;
    }
    if (command === "commit") {
      const r = await commitText(text, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid, journal: fileJournal(args[0]!, deps) });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "catalogue") {
      const r = await catalogueText(text, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "nutrition") {
      const r = await nutritionText(text, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "packs") {
      const r = await packsText(text, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "stock") {
      const r = await stockText(text, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "manques") {
      const r = await manquesText(mealIds, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "bought") {
      const r = await boughtText({ lineId: id(args[0]), words: args.slice(1).join(" "), confirmed }, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "fini") {
      const r = await finiText(itemIds, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    if (command === "reste") {
      const r = await resteText({ itemId: id(args[0]), words: args.slice(1).join(" "), low: lowFlags.length === 0 ? null : lowFlags[0] === "--low" }, { cfg, fetch: deps.fetch, now: deps.now, uuid: deps.uuid });
      (r.exitCode === 0 ? deps.out : deps.err)(r.output);
      return r.exitCode;
    }
    const { result } = await postOp(cfg, deps.fetch, { opId: deps.uuid(), type: write!.type, at: deps.now(), payload: write!.payload });
    if (result.status === "refused") { deps.err(`Refusé : ${result.reason ?? "sans raison"}`); return 1; }
    deps.out(result.status === "noop" ? `Rien à changer${result.reason ? ` : ${result.reason}` : ""}.` : "Enregistré.");
    return 0;
  } catch (error) {
    if (error instanceof Usage) { deps.err(`${error.message}\n\n${USAGE}`); return 2; }
    if (error instanceof CliError) { deps.err(error.message); return error.exitCode; }
    deps.err(`erreur inattendue : ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return 2;
  }
}

if (isEntry(import.meta.url)) {
  run(process.argv.slice(2), {
    fetch: (url, init) => fetch(url, init),
    readSecret: readKeychain,
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => writeFileSync(path, text),
    now: () => new Date().toISOString(),
    env: process.env,
    platform: process.platform,
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    uuid: () => crypto.randomUUID(),
  }).then((code) => process.exit(code));
}
