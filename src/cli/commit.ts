import { groupCourseLines } from "../domain/course-groups";
import type { Snapshot } from "../domain/snapshot";
import { stableStringify } from "../domain/state";
import { COURSE_GROUPS, GROUP_LABELS } from "../domain/vocabulary";
import { checkText } from "./check";
import { fetchState, postOp, type ClientConfig, type FetchLike } from "./client";
import { euros, quantity } from "./format";

/**
 * The op id last sent for each proposal content. Recorded before the op leaves, so a commit whose answer was lost
 * (wifi drop after the Worker applied it) is resent under the same id and the server replays its stored result (§8.2)
 * instead of the rerun being re-checked against a state that already holds the planning.
 */
export interface CommitJournal {
  get(key: string): string | null;
  set(key: string, opId: string): void;
  delete(key: string): void;
}

export interface CommitDeps { cfg: ClientConfig; fetch: FetchLike; now: () => string; uuid: () => string; journal: CommitJournal }

/** Same content → same key, whatever the key order or whitespace of the file. */
export async function proposalKey(proposal: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(proposal))));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Unbought lines in the app's fixed category order (spec §10.2), one row per product as the phone shows them, price after the quantity, then the total against budget. */
export function renderCourses(snap: Snapshot): string {
  const lines = snap.courses.lines.filter((l) => l.boughtAt === null);
  const out = ["Courses"];
  for (const group of COURSE_GROUPS) {
    const rows = groupCourseLines(lines.filter((l) => l.group === group));
    if (!rows.length) continue;
    out.push(` ${GROUP_LABELS[group]}`);
    for (const { head: l, qty, estPriceCents } of rows) {
      out.push(`  - ${l.label}${qty !== null ? ` · ${quantity(qty, l.unit)}` : ""} · ${euros(estPriceCents)}${l.kind !== "planning" ? " (hors budget)" : ""}`);
    }
  }
  out.push("", `Total estimé ${euros(snap.courses.estimateCents)} · budget ${euros(snap.courses.budgetCents)}`);
  return out.join("\n");
}

export async function commitText(text: string, deps: CommitDeps): Promise<{ output: string; exitCode: 0 | 1 }> {
  const state = await fetchState(deps.cfg, deps.fetch);
  const checked = checkText(text, state, deps.now());
  if (checked.result === null) return { output: `${checked.output}\n\nRien n'est envoyé.`, exitCode: 1 };
  const proposal = checked.input;
  const key = await proposalKey(proposal);
  const pending = deps.journal.get(key);
  // a resend must reach the server even when the local check now blocks: the planning it may have created is what blocks it
  if (pending === null && checked.exitCode !== 0) return { output: `${checked.output}\n\nRien n'est envoyé : corrigez les blocages.`, exitCode: 1 };
  const opId = pending ?? `commit-${deps.uuid()}`;
  if (pending === null) deps.journal.set(key, opId);
  const { result, snapshot: after } = await postOp(deps.cfg, deps.fetch, { opId, type: "planning.commit", at: deps.now(), payload: proposal });
  let reply: { output: string; exitCode: 0 | 1 };
  if (result.status === "refused") {
    reply = { output: `Refusé par le serveur : ${result.reason ?? "sans raison"}\nRelancez status, ajustez la proposition puis check.`, exitCode: 1 };
  } else {
    // observed state, not the journal: an earlier attempt that died before the Worker applied anything also leaves a journal entry.
    // Only a planning creates meals, and they are open right after it: a pool meal the state read before sending lacks is this
    // commit's. Cosmetic only: another session's planning landing between the read and the send would read as "created" on a
    // replay; the exit code and the planning count are unaffected, and the app has a single user
    const known = new Set(state.meals.map((m) => m.id));
    const created = after.menu.pool.some((m) => !known.has(m.id));
    const headline = created ? "Planification enregistrée." : "Planification déjà enregistrée (renvoi du même identifiant).";
    reply = { output: `${headline}\n\n${renderCourses(after)}`, exitCode: 0 };
  }
  // postOp only returns a final answer (an unrecorded one exits 2 and keeps the id for the resend): the id has served.
  // Forgotten, a later identical proposal is a new one, checked against the planning this one created, never a replay of
  // it; after a refusal, the same content can be sent again once the state allows it. Forgotten only once the reply is
  // built: a throw on the way leaves the id, so the rerun replays it instead of a fresh id the local check stops
  deps.journal.delete(key);
  return reply;
}
