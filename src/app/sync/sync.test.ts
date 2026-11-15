import { describe, expect, it, vi } from "vitest";
import { applyOp } from "../../domain/ops/apply";
import { snapshot } from "../../domain/snapshot";
import { NOW, fixtureProposal, fixtureState, op } from "../../domain/test-fixtures";
import { MAX_UNRECORDED } from "./outbox";
import { memoryStore, type SyncStore } from "./store";
import { BACKOFF_MS, RETRY_MS, Sync } from "./sync";
import { fakeServer } from "./test-server";

const TAP_AT = "2026-10-12T09:00:00.000Z";
let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}`;
const planned = () => applyOp(fixtureState(), op("planning.commit", fixtureProposal()), NOW).state;

function setup(options: { store?: SyncStore; server?: ReturnType<typeof fakeServer>; online?: boolean } = {}) {
  const server = options.server ?? fakeServer(planned());
  const store = options.store ?? memoryStore();
  const net = { online: options.online ?? true, visible: true };
  // a cancelled timer leaves the list, as clearTimeout takes it off the event loop
  const timers: { run: () => void; ms: number }[] = [];
  const sync = new Sync({
    store, persistent: true, fetch: server.fetch, now: () => TAP_AT, uuid, isOnline: () => net.online, isVisible: () => net.visible,
    schedule: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at !== -1) timers.splice(at, 1);
      };
    },
  });
  const lineId = (label: string) => server.state.shoppingItems.find((l) => l.label === label)!.id;
  const shown = (label: string) => sync.getState().view!.courses.lines.find((l) => l.label === label)!;
  const sentIds = () => server.posts.map((ops) => ops.map((o) => o.opId));
  const serverLine = (label: string) => server.state.shoppingItems.find((l) => l.label === label)!;
  return { sync, server, store, net, timers, lineId, shown, sentIds, serverLine };
}

async function started(options?: Parameters<typeof setup>[0]) {
  const s = setup(options);
  await s.sync.load();
  await s.sync.refresh();
  return s;
}

describe("Sync", () => {
  it("shows the stored snapshot at once, then the server's once a read succeeds", async () => {
    const store = memoryStore();
    await store.write({ snapshot: snapshot(fixtureState(), NOW), put: [], remove: [] }); // an older list: nothing to buy
    const s = setup({ store });
    await s.sync.load();
    expect(s.sync.getState()).toMatchObject({ loaded: true, waitingCount: 0 });
    expect(s.sync.getState().view!.courses.lines).toEqual([]);
    await s.sync.refresh();
    expect(s.shown("comté").boughtAt).toBeNull();
    expect((await store.readSnapshot())!.courses.lines.some((l) => l.label === "comté")).toBe(true);
  });

  // Regression: 5a86852 — a stored snapshot missing a section (an older app's) reached the screens unchecked
  it("ignores a stored snapshot missing a section the screens read", async () => {
    const store = memoryStore();
    const old = snapshot(planned(), NOW);
    await store.write({ snapshot: { ...old, calibration: undefined } as unknown as typeof old, put: [], remove: [] });
    const s = setup({ store });
    await s.sync.load();
    expect(s.sync.getState()).toMatchObject({ loaded: true, view: null });
    await s.sync.refresh();
    expect(s.sync.getState().view!.calibration).toEqual(old.calibration);
  });

  it("keeps a tap made offline, shows it at once, and sends it under its id when the network returns", async () => {
    const s = await started();
    s.net.online = false;
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts).toEqual([]);
    expect(s.shown("comté")).toMatchObject({ boughtAt: TAP_AT, buyOpId: opId });
    expect(s.sync.getState()).toMatchObject({ status: "offline", waitingCount: 1 });
    expect((await s.store.readOutbox()).map((e) => e.op.opId)).toEqual([opId]);

    s.net.online = true;
    await s.sync.refresh();
    expect(s.sentIds()).toEqual([[opId]]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ status: "online", waitingCount: 0 });
    expect(await s.store.readOutbox()).toEqual([]);
    expect(s.shown("comté").buyOpId).toBe(opId); // the server's snapshot names the op, so the row can undo it
  });

  it("keeps a several-op tap in one outbox write, in order, sends it, and « Annuler » takes every op back", async () => {
    const s = await started();
    s.net.online = false;
    const ids = await s.sync.tapMany([
      { type: "shopping.buy", payload: { itemId: s.lineId("comté") } },
      { type: "shopping.buy", payload: { itemId: s.lineId("poireau") } },
    ], "Acheté : comté");
    expect((await s.store.readOutbox()).map((e) => e.op.opId)).toEqual(ids);
    expect(s.shown("comté").boughtAt).toBe(TAP_AT);
    expect(s.shown("poireau").boughtAt).toBe(TAP_AT);
    s.net.online = true;
    await s.sync.refresh();
    expect(s.sentIds().flat()).toEqual(ids);
    expect(s.serverLine("poireau").boughtAt).not.toBeNull();
    for (const id of ids) await s.sync.undo(id, "Acheté : comté");
    await s.sync.flush();
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.serverLine("poireau").boughtAt).toBeNull();
  });

  it("resends an op the server did not record under the same id, waiting between tries, and after the first send and five resends shows it en échec", async () => {
    const s = await started();
    s.server.mode = "unrecorded";
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    for (let resend = 1; resend < MAX_UNRECORDED; resend++) {
      expect(s.sync.getState().failed).toEqual([]);
      expect(s.server.posts).toHaveLength(resend); // nothing goes again before the timer
      const timer = s.timers.shift()!;
      expect(timer.ms).toBe(RETRY_MS);
      timer.run();
      await s.sync.flush();
    }
    expect(s.sentIds()).toEqual(Array.from({ length: MAX_UNRECORDED }, () => [opId]));
    expect(s.sync.getState().waitingCount).toBe(0);
    expect(s.sync.getState().failed.map((e) => [e.op.opId, e.lastReason])).toEqual([[opId, "erreur interne : panne simulée"]]);
    expect(s.timers).toEqual([]);
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(MAX_UNRECORDED);

    s.server.mode = "ok";
    await s.sync.retry(opId);
    await s.sync.flush();
    expect(s.sentIds().at(-1)).toEqual([opId]);
    expect(s.sync.getState().failed).toEqual([]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
  });

  // Regression: 1738c83 — an answer that recorded one op and not another resent the other at once
  it("after an answer that left one op unrecorded and recorded another, waits RETRY_MS before resending it", async () => {
    const s = await started();
    s.net.online = false;
    const comte = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    const poireau = await s.sync.tap("shopping.buy", { itemId: s.lineId("poireau") }, "Acheté : poireau");
    s.net.online = true;
    s.server.mode = "throw-first";
    await s.sync.refresh();
    expect(s.sentIds()).toEqual([[comte, poireau]]);
    expect(s.serverLine("poireau").boughtAt).not.toBeNull();
    expect(s.timers.map((t) => t.ms)).toEqual([RETRY_MS]);
    const later = await s.sync.tap("shopping.buy", { itemId: s.lineId("endive") }, "Acheté : endive");
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(1); // a later tap waits behind the hold too

    s.server.mode = "ok";
    s.timers.shift()!.run();
    await s.sync.flush();
    expect(s.sentIds()).toEqual([[comte, poireau], [comte, later]]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, failed: [], refusals: [] });
  });

  /** Taps a buy and lets it go en échec: the first send and five resends, each answered unrecorded. */
  async function failedBuy(s: Awaited<ReturnType<typeof started>>, mode: "unrecorded" | "blind") {
    s.server.mode = mode;
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    while (s.timers.length > 0) {
      s.timers.shift()!.run();
      await s.sync.flush();
    }
    expect(s.sync.getState().failed.map((e) => e.op.opId)).toEqual([opId]);
    return opId;
  }

  // Regression: 8b45da3 — « Annuler » on an op en échec kept it, so « Réessayer » could still apply what was cancelled
  it("« Annuler » on an op en échec the server never recorded: nothing is left to resend, and the undo's « action introuvable » is not reported", async () => {
    const s = await started();
    const opId = await failedBuy(s, "unrecorded");
    expect(s.serverLine("comté").boughtAt).toBeNull();
    const posts = s.server.posts.length;

    s.server.mode = "ok";
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.sentIds().slice(posts).flat()).toHaveLength(1); // the undo alone
    expect(await s.store.readOutbox()).toEqual([]);
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
    expect(s.shown("comté").boughtAt).toBeNull();
    expect(s.serverLine("comté").boughtAt).toBeNull();
  });

  // Regression: 6b04cb7 — « Annuler » dropped an op en échec, but an op answered unrecorded may have landed (spec §8.2)
  it("« Annuler » on an op en échec that landed unconfirmed sends the undo that takes it back", async () => {
    const s = await started();
    const opId = await failedBuy(s, "blind");
    expect(s.serverLine("comté").boughtAt).not.toBeNull(); // the batch committed; no answer could say so

    s.server.mode = "ok";
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts.at(-1)!.map((o) => [o.type, o.payload])).toEqual([["undo", { targetOpId: opId }]]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.server.state.stockItems.filter((i) => i.label === "comté")).toEqual([]);
    expect(await s.store.readOutbox()).toEqual([]);
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
    expect(s.shown("comté").boughtAt).toBeNull();
  });

  // Regression: b506f3e — an undo queued behind its target kept going alone once the target went en échec
  it("« Annuler » on an op sent but not yet answered: if it goes en échec, it is abandoned with its waiting undo", async () => {
    const s = await started();
    s.server.mode = "unrecorded";
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    for (let resend = 1; resend < MAX_UNRECORDED - 1; resend++) {
      s.timers.shift()!.run();
      await s.sync.flush();
    }
    await s.sync.undo(opId, "Acheté : comté"); // already sent: an undo is queued behind it
    s.timers.shift()!.run();
    await s.sync.flush(); // the buy's sixth unrecorded answer; the undo waits behind it
    s.server.mode = "ok";
    s.timers.shift()!.run();
    await s.sync.flush();
    expect(s.server.posts.map((ops) => ops.map((o) => o.type))).toEqual([
      ...Array.from({ length: MAX_UNRECORDED }, () => ["shopping.buy"]), ["undo"],
    ]);
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
    expect(await s.store.readOutbox()).toEqual([]);
    await s.sync.retry(opId); // nothing left to retry: the cancelled purchase never goes again
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(MAX_UNRECORDED + 1);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.shown("comté").boughtAt).toBeNull();
  });

  // Regression: ae911f8 — « Abandonner » on an op en échec that had landed unconfirmed left it applied on the server
  it("« Abandonner » on an op en échec that landed unconfirmed sends the undo that takes it back, and « Annuler » then sends nothing more", async () => {
    const s = await started();
    const opId = await failedBuy(s, "blind");
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    s.server.mode = "ok";
    const posts = s.server.posts.length;
    await s.sync.abandon(opId);
    await s.sync.flush();
    expect(s.server.posts.slice(posts).map((ops) => ops.map((o) => [o.type, o.payload]))).toEqual([[["undo", { targetOpId: opId }]]]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(posts + 1);
  });

  // Regression: ae911f8 — after « Abandonner » on an op that never landed, « Annuler » sent an undo whose « action introuvable » was shown
  it("« Abandonner » on an op en échec that never landed, then « Annuler »: nothing is shown and nothing more is sent", async () => {
    const s = await started();
    const opId = await failedBuy(s, "unrecorded");
    s.server.mode = "ok";
    await s.sync.abandon(opId);
    await s.sync.flush();
    const posts = s.server.posts.length;
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(posts);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
  });

  // Regression: ae911f8 — an op that landed but went en échec on answers carrying no snapshot stayed shown as never done
  it("after an op goes en échec on answers that carried no snapshot, shows what the server holds", async () => {
    const s = await started();
    await failedBuy(s, "blind");
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.shown("comté").boughtAt).not.toBeNull(); // no refresh: the answers' missing snapshot was read
  });

  // Regression: d5d28ad — an undo sent with a target answered unrecorded was refused « action introuvable » for good
  it("« Annuler » on an op answered unrecorded: the undo waits for the op's final answer, then takes it back", async () => {
    const s = await started();
    s.server.mode = "throw-first";
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    await s.sync.undo(opId, "Acheté : comté");
    s.timers.shift()!.run();
    await s.sync.flush(); // the buy throws again: its undo must not have gone with it
    expect(s.server.posts.map((ops) => ops.map((o) => o.type))).toEqual([["shopping.buy"], ["shopping.buy"]]);
    expect(s.sync.getState().refusals).toEqual([]);

    s.server.mode = "ok";
    s.timers.shift()!.run();
    await s.sync.flush();
    expect(s.server.posts.map((ops) => ops.map((o) => o.type))).toEqual([["shopping.buy"], ["shopping.buy"], ["shopping.buy"], ["undo"]]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.shown("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
    expect(await s.store.readOutbox()).toEqual([]);
  });

  // Regression: a1a965c — an undo and a later re-tick of its line went in one request: the undo refused unrecorded alone,
  // the re-tick was answered noop, then the undo landed and the line ended unbought, with nothing said
  it("a line ticked again behind the undo of its purchase ends bought, even when that undo is refused unrecorded once", async () => {
    const s = await started();
    const first = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    s.net.online = false;
    s.sync.markOffline();
    s.server.mode = "throw-first";
    await s.sync.undo(first, "Acheté : comté");
    expect(s.shown("comté").boughtAt).toBeNull();
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    s.net.online = true;
    await s.sync.flush(); // the undo goes alone and throws: the re-tick waits behind it
    s.server.mode = "ok";
    while (s.timers.length > 0) {
      s.timers.shift()!.run();
      await s.sync.flush();
    }
    expect(s.server.posts.map((ops) => ops.map((o) => o.type))).toEqual([["shopping.buy"], ["undo"], ["undo"], ["shopping.buy"]]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.shown("comté").boughtAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
  });

  // Regression: d5d28ad — an undo of an op answered refused went out anyway, its « rien à annuler » reported too
  it("« Annuler » on an op whose final answer is a refusal: the waiting undo is dropped, and only the op's refusal is reported", async () => {
    const s = await started();
    s.server.mode = "lose-answer";
    const opId = await s.sync.tap("shopping.remove", { itemId: s.lineId("poireau") }, "Retiré : poireau");
    await s.sync.flush();
    s.net.online = false;
    await s.sync.undo(opId, "Retiré : poireau");
    expect((await s.store.readOutbox()).map((e) => e.op.type)).toEqual(["shopping.remove", "undo"]);

    s.server.mode = "ok";
    s.net.online = true;
    const posts = s.server.posts.length;
    await s.sync.refresh();
    expect(s.server.posts.slice(posts).map((ops) => ops.map((o) => o.type))).toEqual([["shopping.remove"]]);
    expect(s.sync.getState().refusals).toEqual([
      { label: "Retiré : poireau", reason: "mettez l'application à jour" },
    ]);
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0 });
    expect(await s.store.readOutbox()).toEqual([]);
  });

  it("stops sending on an Access redirect, keeps every tap, and sends them once a read succeeds", async () => {
    const s = await started();
    s.server.mode = "reauth";
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sync.getState()).toMatchObject({ status: "reauth", waitingCount: 1 });
    const requests = s.server.requests;
    await s.sync.tap("shopping.buy", { itemId: s.lineId("poireau") }, "Acheté : poireau");
    await s.sync.flush();
    expect(s.server.requests).toBe(requests); // spec §8.3: nothing is retried until a login works
    expect(s.sync.getState().waitingCount).toBe(2);

    s.server.mode = "ok";
    await s.sync.refresh();
    expect(s.sync.getState()).toMatchObject({ status: "online", waitingCount: 0 });
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.serverLine("poireau").boughtAt).not.toBeNull();
  });

  // Regression: 60c1699 — going offline replaced « reconnexion », so the next tap POSTed under the lapsed session
  it("keeps waiting for a login across a spell offline: nothing is sent until a read succeeds", async () => {
    const s = await started();
    s.server.mode = "reauth";
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sync.getState().status).toBe("reauth");

    s.net.online = false;
    await s.sync.refresh();
    s.sync.markOffline();
    expect(s.sync.getState().status).toBe("offline");
    s.net.online = true;
    s.server.mode = "ok";
    const requests = s.server.requests;
    await s.sync.tap("shopping.buy", { itemId: s.lineId("poireau") }, "Acheté : poireau");
    await s.sync.flush();
    expect(s.server.requests).toBe(requests);
    expect(s.server.posts).toEqual([]);

    await s.sync.refresh();
    expect(s.sync.getState()).toMatchObject({ status: "online", waitingCount: 0 });
    expect(s.serverLine("poireau").boughtAt).not.toBeNull();
  });

  it("reports a refused op once with its label and reason, and sends no undo for an op that changed nothing", async () => {
    const s = await started();
    const opId = await s.sync.tap("shopping.remove", { itemId: s.lineId("poireau") }, "Retiré : poireau");
    await s.sync.flush();
    expect(s.sync.getState().refusals).toEqual([
      { label: "Retiré : poireau", reason: "mettez l'application à jour" },
    ]);
    expect(s.sync.getState().waitingCount).toBe(0);
    await s.sync.undo(opId, "Retiré : poireau");
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(1);
    s.sync.dismissRefusals();
    expect(s.sync.getState().refusals).toEqual([]);
  });

  // Regression: d873a7a — an answer with no snapshot dropped its applied ops from the view until the next refresh
  it("after an answer that applied ops but carried no snapshot, reads the state, so the ops stay shown", async () => {
    const s = await started();
    s.server.mode = "no-snapshot";
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sentIds()).toEqual([[opId]]);
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
    expect(s.shown("comté").boughtAt).not.toBeNull();
    expect(s.shown("comté").buyOpId).toBe(opId);
    expect((await s.store.readSnapshot())!.courses.lines.find((l) => l.label === "comté")!.buyOpId).toBe(opId);
  });

  it("a lost answer: the op stays, goes again under its id and is replayed, and its « Annuler » sends an undo instead of dropping it", async () => {
    const s = await started();
    s.server.mode = "lose-answer";
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.serverLine("comté").boughtAt).not.toBeNull(); // the server applied it
    expect(s.sync.getState().waitingCount).toBe(1); // the phone cannot know
    expect(s.server.posts.flat().every((o) => o.opId === opId)).toBe(true);

    s.net.online = false;
    await s.sync.undo(opId, "Acheté : comté");
    expect((await s.store.readOutbox()).map((e) => e.op.type)).toEqual(["shopping.buy", "undo"]);

    s.server.mode = "ok";
    s.net.online = true;
    const posts = s.server.posts.length;
    await s.sync.refresh();
    expect(s.server.posts.slice(posts).map((ops) => ops.map((o) => o.type))).toEqual([["shopping.buy"], ["undo"]]);
    expect(s.serverLine("comté").boughtAt).toBeNull(); // the undo reached the purchase
    expect(s.server.state.stockItems.filter((i) => i.label === "comté")).toEqual([]);
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  // the send count on disk is what makes « Annuler » after a reload send an undo instead of dropping the op
  it("counts a send on disk before the request leaves", async () => {
    const disk = memoryStore();
    let release: (() => void) | null = null;
    const slow: SyncStore = {
      ...disk,
      write: async (change) => {
        if (change.put.some((e) => e.sends > 0)) await new Promise<void>((resolve) => { release = resolve; });
        await disk.write(change);
      },
    };
    const s = await started({ store: slow });
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(release).not.toBeNull();
    expect(s.server.requests).toBe(1); // the opening GET only
    release!();
    await s.sync.flush();
    expect(s.sentIds()).toEqual([[opId]]);
  });

  // Regression: 0b3d195 — a second « Annuler » on an unsent op found it gone and sent an undo the server refused
  it("« Annuler » tapped twice on an unsent op sends nothing", async () => {
    const s = await started();
    s.net.online = false;
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await Promise.all([s.sync.undo(opId, "Acheté : comté"), s.sync.undo(opId, "Acheté : comté")]);
    s.net.online = true;
    await s.sync.refresh();
    expect(s.server.posts).toEqual([]);
    expect(await s.store.readOutbox()).toEqual([]);
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  // Regression: 0b3d195 — a second « Annuler » on an op en échec sent a second undo, refused « déjà annulée »
  it("« Annuler » tapped twice on an op en échec sends one undo", async () => {
    const s = await started();
    const opId = await failedBuy(s, "blind");
    const posts = s.server.posts.length;
    s.server.mode = "ok";
    await Promise.all([s.sync.undo(opId, "Acheté : comté"), s.sync.undo(opId, "Acheté : comté")]);
    await s.sync.flush();
    expect(s.server.posts.slice(posts).flat().map((o) => o.type)).toEqual(["undo"]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  // Regression: dff6a88 — a second « Annuler » after the first undo was answered sent an undo refused « déjà annulée »
  it("« Annuler » tapped again once the first undo was answered sends nothing", async () => {
    const s = await started();
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts.map((ops) => ops.map((o) => o.type))).toEqual([["shopping.buy"], ["undo"]]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  // Regression: ae911f8 — a new « Annuler » after an undo that landed unconfirmed was abandoned showed « déjà annulée »
  it("« Annuler » on an op whose undo landed unconfirmed and was abandoned en échec sends a new undo, and shows nothing", async () => {
    const s = await started();
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    s.server.mode = "blind";
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    while (s.timers.length > 0) {
      s.timers.shift()!.run();
      await s.sync.flush();
    }
    const [failedUndo] = s.sync.getState().failed;
    await s.sync.abandon(failedUndo!.op.opId);
    expect(s.serverLine("comté").boughtAt).toBeNull(); // the undo had landed
    s.server.mode = "ok";
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts.at(-1)!.map((o) => [o.type, o.payload])).toEqual([["undo", { targetOpId: opId }]]);
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
  });

  // Regression: ae911f8 — reloaded before the read that follows an answer with no snapshot, the phone sent a second undo
  it("a reload before the read that follows an answer with no snapshot keeps that answer: the row's « Annuler » sends no second undo", async () => {
    const first = await started();
    const opId = await first.sync.tap("shopping.buy", { itemId: first.lineId("comté") }, "Acheté : comté");
    await first.sync.flush();
    first.server.mode = "no-snapshot";
    let reads = true;
    const cut: typeof first.server.fetch = (url, init) => (url === "/api/state" && !reads ? new Promise<Response>(() => {}) : first.server.fetch(url, init));
    const page = new Sync({ store: first.store, persistent: true, fetch: cut, now: () => TAP_AT, uuid, isOnline: () => true, isVisible: () => true, schedule: () => () => undefined });
    await page.load();
    await page.refresh();
    reads = false; // the app is closed before the read answers
    await page.undo(opId, "Acheté : comté");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first.serverLine("comté").boughtAt).toBeNull();
    first.server.mode = "ok";

    const second = setup({ store: first.store, server: first.server });
    await second.sync.load();
    expect(second.sync.getState().view!.courses.lines.find((l) => l.label === "comté")!.boughtAt).toBeNull(); // the kept answer still shows
    const posts = second.server.posts.length;
    await second.sync.undo(opId, "Acheté : comté"); // the stored snapshot's row still names the purchase
    await second.sync.refresh();
    expect(second.server.posts).toHaveLength(posts);
    expect(second.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
    expect(await second.store.readOutbox()).toEqual([]);
  });

  // Regression: 48132bc — once an undo went en échec and was abandoned, « Annuler » on its op sent nothing again
  it("« Annuler » on an op whose earlier undo went en échec and was abandoned sends a new undo", async () => {
    const s = await started();
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    s.server.mode = "unrecorded";
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    while (s.timers.length > 0) {
      s.timers.shift()!.run();
      await s.sync.flush();
    }
    const [failedUndo] = s.sync.getState().failed;
    expect(failedUndo!.op).toMatchObject({ type: "undo", payload: { targetOpId: opId } });
    await s.sync.abandon(failedUndo!.op.opId);
    s.server.mode = "ok";
    await s.sync.refresh();
    expect(s.shown("comté").buyOpId).toBe(opId); // the purchase is still on the server, and its row still names it

    const posts = s.server.posts.length;
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts.slice(posts).flat().map((o) => [o.type, o.payload])).toEqual([["undo", { targetOpId: opId }]]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, refusals: [] });
  });

  // Regression: ce748f9 — an undo refused « déjà passé en caisse » blocked every later « Annuler » on its op
  it("« Annuler » again on an op whose undo was refused for a reason that can pass sends a new undo", async () => {
    const s = await started();
    const buy = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    const trip = await s.sync.tap("trip.record", { place: "marche", totalCents: 1250, date: "2026-10-12", itemIds: [s.lineId("comté")] }, "Passage en caisse");
    await s.sync.flush();
    await s.sync.undo(buy, "Acheté : comté");
    await s.sync.flush();
    expect(s.sync.getState().refusals).toEqual([{ label: "Annuler « Acheté : comté »", reason: "déjà passé en caisse" }]);
    await s.sync.undo(trip, "Passage en caisse");
    await s.sync.flush();

    const posts = s.server.posts.length;
    await s.sync.undo(buy, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts.slice(posts).flat().map((o) => [o.type, o.payload])).toEqual([["undo", { targetOpId: buy }]]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [{ label: "Annuler « Acheté : comté »", reason: "déjà passé en caisse" }] });
  });

  // « déjà annulée » says the cancel holds, so it is not shown
  it("« Annuler » again on an op another phone had already undone, or abandoned en échec without landing, sends nothing", async () => {
    const s = await started();
    const opId = await failedBuy(s, "unrecorded");
    s.server.mode = "ok";
    await s.sync.undo(opId, "Acheté : comté"); // answered « action introuvable », not reported: it never landed
    await s.sync.flush();
    const posts = s.server.posts.length;
    await s.sync.undo(opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts).toHaveLength(posts);

    const t = await started();
    const buy = await t.sync.tap("shopping.buy", { itemId: t.lineId("comté") }, "Acheté : comté");
    await t.sync.flush();
    const fromOtherPhone = op("undo", { targetOpId: buy });
    await t.server.fetch("/api/ops", { method: "POST", body: JSON.stringify({ ops: [fromOtherPhone] }) });
    await t.sync.undo(buy, "Acheté : comté");
    await t.sync.flush();
    expect(t.server.posts.at(-1)!.map((o) => o.type)).toEqual(["undo"]);
    expect(t.sync.getState().refusals).toEqual([]);
    const sent = t.server.posts.length;
    await t.sync.undo(buy, "Acheté : comté");
    await t.sync.flush();
    expect(t.server.posts).toHaveLength(sent);
    expect(t.sync.getState().waitingCount).toBe(0);
  });

  // Regression: 0b3d195 — after a reload, « Annuler » on an op refused before it sent an undo refused « action introuvable »
  it("after a reload, « Annuler » on an op this phone knows nothing of sends nothing", async () => {
    const first = await started();
    const opId = await first.sync.tap("shopping.remove", { itemId: first.lineId("poireau") }, "Retiré : poireau");
    await first.sync.flush();
    expect(first.sync.getState().refusals).toHaveLength(1);
    const second = await started({ store: first.store, server: first.server });
    const posts = second.server.posts.length;
    await second.sync.undo(opId, "Retiré : poireau");
    await second.sync.flush();
    expect(second.server.posts).toHaveLength(posts);
    expect(second.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  it("« Annuler » on a row bought from another phone sends the undo its snapshot names", async () => {
    const base = planned();
    const comte = base.shoppingItems.find((l) => l.label === "comté")!.id;
    const elsewhere = op("shopping.buy", { itemId: comte });
    const s = await started({ server: fakeServer(applyOp(base, elsewhere, NOW).state) });
    expect(s.shown("comté").buyOpId).toBe(elsewhere.opId);
    await s.sync.undo(elsewhere.opId, "Acheté : comté");
    await s.sync.flush();
    expect(s.server.posts.flat().map((o) => o.payload)).toEqual([{ targetOpId: elsewhere.opId }]);
    expect(s.serverLine("comté").boughtAt).toBeNull();
    expect(s.sync.getState().refusals).toEqual([]);
  });

  it("« Annuler » on a meal another phone cooked sends the undo its snapshot names, and the meal is back in the pool", async () => {
    const elsewhere = op("meal.cook", { mealId: 1, sheet: { verdict: "correct" } });
    const s = await started({ server: fakeServer(applyOp(planned(), elsewhere, NOW).state) });
    expect(s.sync.getState().view!.menu.recentlyCooked).toEqual([expect.objectContaining({ mealId: 1, cookOpId: elsewhere.opId, undoing: false })]);
    await s.sync.undo(elsewhere.opId, "Cuisiné : Gratin de poireaux au comté");
    await s.sync.flush();
    expect(s.server.posts.flat().map((o) => o.payload)).toEqual([{ targetOpId: elsewhere.opId }]);
    expect(s.server.state.meals.find((m) => m.id === 1)).toMatchObject({ cookedAt: null, verdict: null });
    expect(s.sync.getState().view!.menu.pool.map((m) => m.id)).toContain(1);
    expect(s.sync.getState().refusals).toEqual([]);
  });

  // the other phone cooked the meal first; the server keeps its sheet and drops this one
  it("says once that a Cuisiné sheet was dropped when the other phone cooked the meal first, and stays quiet for an empty one", async () => {
    const s = await started();
    s.server.elsewhere(op("meal.cook", { mealId: 1, sheet: {} }));
    s.server.elsewhere(op("meal.cook", { mealId: 2, sheet: {} }));
    await s.sync.tap("meal.cook", { mealId: 1, sheet: { verdict: "a_refaire", note: "trop cuit", items: [] } }, "Cuisiné : Gratin de poireaux au comté");
    await s.sync.tap("meal.cook", { mealId: 2, sheet: { verdict: null, note: null, items: [] } }, "Cuisiné : Salade d'endives au comté");
    await s.sync.flush();
    expect(s.server.posts.flat().map((o) => o.type)).toEqual(["meal.cook", "meal.cook"]);
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [], droppedSheets: ["Cuisiné : Gratin de poireaux au comté"] });
    expect(s.server.state.meals.find((m) => m.id === 1)).toMatchObject({ verdict: null, note: null });
    await s.sync.refresh();
    expect(s.sync.getState().droppedSheets).toEqual(["Cuisiné : Gratin de poireaux au comté"]); // a read tells it no second time
    s.sync.dismissDroppedSheets();
    expect(s.sync.getState().droppedSheets).toEqual([]);
  });

  it("a meal cooked offline leaves the pool at once, and its cook reaches the server once back online", async () => {
    const s = await started();
    s.net.online = false;
    await s.sync.tap("meal.cook", { mealId: 2, sheet: { verdict: null, note: "trop salé", items: [] } }, "Cuisiné : Salade d'endives au comté");
    expect(s.sync.getState().view!.menu.pool.map((m) => m.id)).toEqual([1, 3]);
    expect(s.sync.getState().waitingCount).toBe(1);
    s.net.online = true;
    await s.sync.refresh();
    expect(s.server.state.meals.find((m) => m.id === 2)).toMatchObject({ note: "trop salé" });
    expect(s.server.state.meals.find((m) => m.id === 2)!.cookedAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  it("cancels on the phone an op never sent, and nothing reaches the server", async () => {
    const s = await started();
    s.net.online = false;
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.undo(opId, "Acheté : comté");
    expect(await s.store.readOutbox()).toEqual([]);
    expect(s.shown("comté").boughtAt).toBeNull();
    s.net.online = true;
    await s.sync.refresh();
    expect(s.server.posts).toEqual([]);
  });

  // Regression: 81ea95c — a failed outbox write threw from tap: the tick showed and was never sent, and « Annuler » had no id
  it("still sends a tap whose write to the store failed, returns its id, and says the phone no longer keeps offline taps", async () => {
    const disk = memoryStore();
    let failures = 1;
    const flaky: SyncStore = {
      ...disk,
      write: async (change) => {
        if (change.put.length > 0 && failures-- > 0) throw new DOMException("quota", "QuotaExceededError");
        await disk.write(change);
      },
    };
    const s = await started({ store: flaky });
    expect(s.sync.getState().persistent).toBe(true);
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sentIds()).toEqual([[opId]]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.sync.getState().persistent).toBe(false);
  });

  // Regression: 5e4cb9c — a store failing every write threw from drain's send count, so no tap was ever POSTed
  it("still sends taps when every write to the store fails", async () => {
    const disk = memoryStore();
    const broken: SyncStore = {
      ...disk,
      write: async (change) => {
        if (change.put.length > 0) throw new DOMException("quota", "QuotaExceededError");
        await disk.write(change);
      },
    };
    const s = await started({ store: broken });
    const comte = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    const poireau = await s.sync.tap("shopping.buy", { itemId: s.lineId("poireau") }, "Acheté : poireau");
    await s.sync.flush();
    expect(s.sentIds()).toEqual([[comte], [poireau]]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.serverLine("poireau").boughtAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ persistent: false, waitingCount: 0 });
  });

  /** A store that works until `broken.on` is set, then refuses every outbox write. */
  function breakable() {
    const disk = memoryStore();
    const broken = { on: false };
    const refuse = () => Promise.reject(new DOMException("quota", "QuotaExceededError"));
    const store: SyncStore = {
      ...disk,
      write: (change) => (broken.on && (change.replace === true || change.put.length + change.remove.length > 0) ? refuse() : disk.write(change)),
    };
    return { disk, broken, store };
  }

  // Regression: b80b22f — « Réessayer » rejected on a failed write, before the flush that resends the op
  it("« Réessayer » resends the op by itself when the store refuses the write, and says taps no longer persist", async () => {
    const { broken, store } = breakable();
    const s = await started({ store });
    const opId = await failedBuy(s, "unrecorded");
    const posts = s.server.posts.length;
    broken.on = true;
    s.server.mode = "ok";
    await expect(s.sync.retry(opId)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5)); // no flush from the test: retry must start it
    expect(s.sentIds().slice(posts)).toEqual([[opId]]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ failed: [], waitingCount: 0, persistent: false });
  });

  // Regression: b80b22f — a cancel or « Abandonner » whose delete failed rejected, the phone still claiming taps persist
  it("a cancel and « Abandonner » whose delete the store refuses still take effect, and say taps no longer persist", async () => {
    const cancelled = breakable();
    const s = await started({ store: cancelled.store });
    s.net.online = false;
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    cancelled.broken.on = true;
    await expect(s.sync.undo(opId, "Acheté : comté")).resolves.toBeUndefined();
    expect(s.sync.getState()).toMatchObject({ waitingCount: 0, persistent: false });
    expect(s.shown("comté").boughtAt).toBeNull();
    s.net.online = true;
    await s.sync.refresh();
    expect(s.server.posts).toEqual([]);

    const abandoned = breakable();
    const t = await started({ store: abandoned.store });
    const failed = await failedBuy(t, "unrecorded");
    abandoned.broken.on = true;
    await expect(t.sync.abandon(failed)).resolves.toBeUndefined();
    // the op may have landed, so its undo waits to be sent
    expect(t.sync.getState()).toMatchObject({ failed: [], waitingCount: 1, persistent: false });
  });

  // Regression: 13d9f3c — the store refused the send count, so after a reload « Annuler » found the op counted as
  // never sent and dropped it, though the row named it as bought: the purchase stayed on the server
  it("« Annuler » on an op a row names as bought sends an undo, even when the store lost its send count", async () => {
    const disk = memoryStore();
    const first = await started({ store: disk });
    first.net.online = false;
    const opId = await first.sync.tap("shopping.buy", { itemId: first.lineId("comté") }, "Acheté : comté");
    const unsent = await disk.readOutbox();
    first.net.online = true;
    await first.sync.flush();
    await first.sync.refresh();
    // the op back on disk as never sent, next to a snapshot naming it bought: since a refused write is followed by
    // whole rewrites it no longer leaves that, but a second app instance still can (store.ts)
    await disk.write({ put: unsent, remove: [] });
    expect((await disk.readOutbox()).map((e) => [e.op.opId, e.sends])).toEqual([[opId, 0]]);
    expect((await disk.readSnapshot())!.courses.lines.find((l) => l.label === "comté")!.buyOpId).toBe(opId);

    const second = setup({ store: disk, server: first.server, online: false });
    await second.sync.load();
    await second.sync.undo(opId, "Acheté : comté");
    second.net.online = true;
    await second.sync.refresh();
    expect(second.serverLine("comté").boughtAt).toBeNull();
    expect(second.sync.getState()).toMatchObject({ waitingCount: 0, refusals: [] });
  });

  /** A store that refuses every write while `broken.on` is set, as WebKit's « Connection to Indexed Database server lost ». */
  function lost() {
    const disk = memoryStore();
    const broken = { on: false };
    const store: SyncStore = {
      ...disk,
      write: async (change) => {
        if (broken.on) throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
        await disk.write(change);
      },
    };
    return { disk, broken, store };
  }

  // Regression: 56a647b — writes after a refused one carried only their own difference, so the cancel the refused
  // delete held never reached the disk: after a reload the tick came back and was sent
  it("a cancel whose delete the store refused stays cancelled after a reload, once a later write lands", async () => {
    const { broken, store } = lost();
    const first = await started({ store });
    first.net.online = false;
    const opId = await first.sync.tap("shopping.buy", { itemId: first.lineId("comté") }, "Acheté : comté");
    broken.on = true;
    await first.sync.undo(opId, "Acheté : comté");
    expect(first.sync.getState()).toMatchObject({ waitingCount: 0, persistent: false });
    broken.on = false;
    await first.sync.refresh(); // the app back in the foreground, still offline: nothing to send, the disk caught up

    const second = setup({ store, server: first.server });
    await second.sync.load();
    await second.sync.refresh();
    expect(second.server.posts).toEqual([]);
    expect(second.serverLine("comté").boughtAt).toBeNull();
    expect(second.sync.getState().waitingCount).toBe(0);
  });

  // Regression: 56a647b — an op answered while the store refused writes stayed on disk as never sent: after a
  // reload an ajout that had landed showed twice, once pending, and « Annuler » would have dropped it on the phone only
  it("an op answered while the store refused writes is gone from disk once a later write lands", async () => {
    const { disk, broken, store } = lost();
    const first = await started({ store });
    first.net.online = false;
    await first.sync.tap("shopping.add", { label: "piles", isFood: false }, "Ajouté : piles");
    broken.on = true;
    first.net.online = true;
    await first.sync.flush();
    expect(first.serverLine("piles").removedAt).toBeNull();
    broken.on = false;
    await first.sync.flush(); // nothing left to send: the disk catches up alone
    expect(await disk.readOutbox()).toEqual([]);

    const second = setup({ store, server: first.server, online: false });
    await second.sync.load();
    const rows = second.sync.getState().view!.courses.lines.filter((l) => l.label === "piles");
    expect(rows.map((l) => l.pending)).toEqual([false]);
  });

  // Regression: 557594e — a snapshot write the store refused on a read was only logged, the phone still saying taps persist
  it("a read whose snapshot the store refuses still shows it, and says taps no longer persist", async () => {
    const disk = memoryStore();
    const refusing: SyncStore = {
      ...disk,
      write: (change) => (change.snapshot ? Promise.reject(new DOMException("quota", "QuotaExceededError")) : disk.write(change)),
    };
    const s = setup({ store: refusing });
    await s.sync.load();
    await s.sync.refresh(); // nothing waits, so no POST answer writes a snapshot through another path
    expect(s.server.posts).toEqual([]);
    expect(s.shown("comté").boughtAt).toBeNull();
    expect(s.sync.getState()).toMatchObject({ status: "online", persistent: false });
  });

  // Regression: 1e3fe52 — a screen throwing while it rendered a tap said taps no longer persist
  it("a screen that throws while it renders leaves the other screens told and the phone still saying taps persist", async () => {
    const s = await started();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let throws = true;
    let told = 0;
    s.sync.subscribe(() => {
      if (throws) throw new Error("rendu cassé");
    });
    s.sync.subscribe(() => {
      told += 1;
    });
    try {
      const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
      throws = false;
      await s.sync.flush();
      expect(told).toBeGreaterThan(0);
      expect(logged).toHaveBeenCalled();
      expect(s.sentIds()).toEqual([[opId]]);
      expect(s.sync.getState()).toMatchObject({ persistent: true, waitingCount: 0 });
      expect((await s.store.readOutbox())).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  // Regression: b588b82 — a cancel was shown before its delete committed, so the OS closing the app then sent the op
  it("shows a cancel only once the op is off disk, and never sends it meanwhile", async () => {
    const disk = memoryStore();
    let release: (() => void) | null = null;
    const slow: SyncStore = {
      ...disk,
      write: async (change) => {
        if (change.remove.length > 0) await new Promise<void>((resolve) => { release = resolve; });
        await disk.write(change);
      },
    };
    const s = await started({ store: slow });
    s.net.online = false;
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    const cancelling = s.sync.undo(opId, "Acheté : comté");
    await Promise.resolve();
    expect(s.shown("comté").boughtAt).toBe(TAP_AT);
    s.net.online = true;
    await s.sync.flush();
    expect(s.server.posts).toEqual([]);
    release!();
    await cancelling;
    expect(s.shown("comté").boughtAt).toBeNull();
    expect(s.sync.getState().waitingCount).toBe(0);
    expect(await disk.readOutbox()).toEqual([]);
  });

  // Regression: 15b1c9e — the undo and the removal of its op en échec were two writes: the OS killing the app
  // between them left both on disk, and after a reload the undo waited forever for its op, holding every later tap
  it("the OS killing the app during « Annuler » on an op en échec keeps all of it or none, and later taps still leave", async () => {
    const disk = memoryStore();
    const server = fakeServer(planned());
    const kill = { at: null as string | null, dead: false };
    // the app dies at the first write that takes `kill.at` off disk: that write, and every later one, never lands
    const dying: SyncStore = {
      ...disk,
      write: (change) => {
        if (kill.dead || (kill.at !== null && change.remove.includes(kill.at))) {
          kill.dead = true;
          return new Promise<void>(() => {});
        }
        return disk.write(change);
      },
    };
    const first = await started({ store: dying, server });
    const opId = await failedBuy(first, "unrecorded");
    kill.at = opId;
    void first.sync.undo(opId, "Acheté : comté");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(kill.dead).toBe(true);

    server.mode = "ok";
    const posts = server.posts.length;
    const second = setup({ store: disk, server });
    await second.sync.load();
    await second.sync.refresh();
    const poireau = await second.sync.tap("shopping.buy", { itemId: second.lineId("poireau") }, "Acheté : poireau");
    await second.sync.flush();
    expect(second.sentIds().slice(posts)).toEqual([[poireau]]);
    expect(second.serverLine("poireau").boughtAt).not.toBeNull();
    // the cancel never reached the disk, so it was never shown: the op is still en échec, for the user to decide again
    expect(second.sync.getState()).toMatchObject({ waitingCount: 0, failed: [expect.objectContaining({ op: expect.objectContaining({ opId }) })] });
  });

  it("never has two requests in flight: a tap made during a request goes in the next one, in tap order", async () => {
    const s = await started();
    const comte = s.lineId("comté");
    const poireau = s.lineId("poireau");
    await Promise.all([
      s.sync.tap("shopping.buy", { itemId: comte }, "Acheté : comté"),
      s.sync.tap("shopping.buy", { itemId: poireau }, "Acheté : poireau"),
      s.sync.refresh(),
    ]);
    await s.sync.flush();
    expect(s.server.maxInFlight()).toBe(1);
    expect(s.server.posts.flat().map((o) => (o.payload as { itemId: number }).itemId)).toEqual([comte, poireau]);
    expect(s.sync.getState().waitingCount).toBe(0);
  });

  it("sends more than 100 waiting ops in requests of 100, in tap order", async () => {
    const s = await started();
    s.net.online = false;
    for (let i = 0; i < 150; i++) await s.sync.tap("envie.add", { text: `envie ${i}`, url: null }, `Envie : ${i}`);
    s.net.online = true;
    await s.sync.refresh();
    expect(s.server.posts.map((ops) => ops.length)).toEqual([100, 50]);
    expect(s.server.posts.flat().map((o) => (o.payload as { text: string }).text)).toEqual(Array.from({ length: 150 }, (_, i) => `envie ${i}`));
  });

  // « Mettre à jour » reloads the page; the outbox must survive it
  it("a reload — after « Mettre à jour » too — keeps the waiting ops and sends each under its id", async () => {
    const first = await started();
    first.net.online = false;
    const opId = await first.sync.tap("shopping.buy", { itemId: first.lineId("comté") }, "Acheté : comté");
    const second = setup({ store: first.store, server: first.server });
    await second.sync.load();
    expect(second.sync.getState().waitingCount).toBe(1);
    expect(second.shown("comté").boughtAt).toBe(TAP_AT);
    await second.sync.refresh();
    expect(second.sentIds()).toEqual([[opId]]);
    expect(second.sync.getState().waitingCount).toBe(0);
  });

  // shown before its IndexedDB write commits, a tick is lost to a reload made right after it
  it("shows a tap only once its op is on disk, so a tick on screen survives the app being closed", async () => {
    const disk = memoryStore();
    let release: (() => void) | null = null;
    const slow: SyncStore = {
      ...disk,
      write: async (change) => {
        if (change.put.length > 0) await new Promise<void>((resolve) => { release = resolve; });
        await disk.write(change);
      },
    };
    const s = await started({ store: slow });
    s.net.online = false;
    const tapped = s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await Promise.resolve();
    expect(s.shown("comté").boughtAt).toBeNull();
    expect(s.sync.getState().waitingCount).toBe(0);
    release!();
    await tapped;
    expect(s.shown("comté").boughtAt).toBe(TAP_AT);
    expect(await disk.readOutbox()).toHaveLength(1);
  });
});

describe("Sync resend after a failed request", () => {
  const next = async (s: Awaited<ReturnType<typeof started>>) => {
    s.timers.shift()!.run();
    await s.sync.flush();
  };

  // Regression: 3eace32 — a request that failed with the phone online (no answer, or a 5xx) scheduled no resend: the taps waited for the next foreground or network event
  it("resends a request that got no answer after 2, 5 and 15 seconds, then every 30 while the app is visible, and stops once one lands", async () => {
    const s = await started();
    s.server.mode = "offline"; // fetch throws while navigator.onLine says online: the shop's dead zone
    const opId = await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sync.getState()).toMatchObject({ status: "offline", waitingCount: 1 });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(s.timers).toHaveLength(1);
      delays.push(s.timers[0]!.ms);
      await next(s);
    }
    expect(delays).toEqual([...BACKOFF_MS, BACKOFF_MS.at(-1)]);
    expect(delays).toEqual([2000, 5000, 15000, 30000, 30000]);
    s.server.mode = "ok";
    await next(s);
    expect(s.sentIds().at(-1)).toEqual([opId]);
    expect(s.serverLine("comté").boughtAt).not.toBeNull();
    expect(s.sync.getState()).toMatchObject({ status: "online", waitingCount: 0 });
    expect(s.timers).toEqual([]);

    // the next failure starts again from the first delay
    s.server.mode = "unavailable";
    await s.sync.tap("shopping.buy", { itemId: s.lineId("poireau") }, "Acheté : poireau");
    await s.sync.flush();
    expect(s.sync.getState().status).toBe("server");
    expect(s.timers.map((t) => t.ms)).toEqual([BACKOFF_MS[0]]);
  });

  it("schedules no resend while the app is hidden, cancels a waiting one when it is hidden, and none when nothing waits", async () => {
    const s = await started();
    s.server.mode = "unavailable";
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.timers).toHaveLength(1);
    s.net.visible = false;
    s.sync.hidden();
    expect(s.timers).toEqual([]);
    await s.sync.refresh(); // a read and a send can still happen hidden (the network returning): no timer follows
    expect(s.timers).toEqual([]);

    s.net.visible = true;
    s.server.mode = "offline";
    await s.sync.refresh(); // back in the foreground
    expect(s.timers.map((t) => t.ms)).toEqual([BACKOFF_MS[0]]);
    s.server.mode = "ok";
    await next(s);
    expect(s.sync.getState().waitingCount).toBe(0);
    s.server.mode = "offline";
    await s.sync.refresh(); // a failed read with nothing waiting: no polling
    expect(s.timers).toEqual([]);
  });

  // Regression: 207b7de — a read that landed left the series' count behind: the next failure started at 15 s instead of 2 s
  it("starts the next failure series from the first delay once a read lands", async () => {
    const s = await started();
    s.server.mode = "post-down"; // reads land, sends do not
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    await next(s);
    expect(s.timers.map((t) => t.ms)).toEqual([BACKOFF_MS[1]]);
    await s.sync.refresh(); // the read lands; the send fails again while the 5 s resend still waits
    await next(s);
    expect(s.timers.map((t) => t.ms)).toEqual([BACKOFF_MS[0]]);
  });

  // Regression: e30fa2f — every 4xx was classed a server failure and resent every 30 s: a refused request never changes its answer
  it("does not resend on a timer a request the server refused with a 4xx", async () => {
    const s = await started();
    s.server.mode = "bad-request";
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sync.getState()).toMatchObject({ status: "server", waitingCount: 1 });
    expect(s.timers).toEqual([]);
    s.server.mode = "ok";
    await s.sync.refresh(); // the next foreground or network event still sends it
    expect(s.sync.getState().waitingCount).toBe(0);
  });

  it("does not resend on its own after an Access redirect, nor while the phone says it is offline", async () => {
    const s = await started();
    s.server.mode = "reauth";
    await s.sync.tap("shopping.buy", { itemId: s.lineId("comté") }, "Acheté : comté");
    await s.sync.flush();
    expect(s.sync.getState().status).toBe("reauth");
    expect(s.timers).toEqual([]);
    const t = await started();
    t.net.online = false;
    await t.sync.tap("shopping.buy", { itemId: t.lineId("comté") }, "Acheté : comté");
    await t.sync.flush();
    expect(t.timers).toEqual([]);
  });
});
