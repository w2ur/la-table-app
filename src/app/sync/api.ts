import type { Snapshot } from "../../domain/snapshot";
import type { Op, OpsAnswer } from "./types";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** What an /api call came to: a body, no network, an Access login to redo (spec §8.3), or a server failure. */
export type Outcome<T> = { kind: "ok"; body: T } | { kind: "offline" } | { kind: "reauth" } | { kind: "server"; status: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATUSES = ["applied", "noop", "refused"];

/** The parts of a snapshot the app reads; anything less is a broken answer, not an empty list. */
export function isSnapshot(v: unknown): v is Snapshot {
  if (!isObject(v) || typeof v.version !== "number" || typeof v.today !== "string") return false;
  const { menu, courses, reste, lastTrip } = v;
  return isObject(menu) && ["pool", "recentlyCooked", "envies"].every((k) => Array.isArray(menu[k]))
    && isObject(courses) && Array.isArray(courses.lines)
    && typeof courses.estimateCents === "number" && typeof courses.budgetCents === "number"
    && isObject(reste) && ["urgent", "reserved", "libre", "placard"].every((k) => Array.isArray(reste[k]))
    && (lastTrip === null || isObject(lastTrip)) && isObject(v.calibration);
}

export function isOpsAnswer(v: unknown): v is OpsAnswer {
  if (!isObject(v) || !Array.isArray(v.results) || !Array.isArray(v.unrecorded)) return false;
  return v.results.every((r) => isObject(r) && (typeof r.opId === "string" || r.opId === null) && STATUSES.includes(r.status as string))
    && v.unrecorded.every((id) => typeof id === "string")
    && (v.snapshot === null || isSnapshot(v.snapshot));
}

async function call<T>(fetchImpl: Fetcher, url: string, init: RequestInit, valid: (v: unknown) => v is T): Promise<Outcome<T>> {
  let res: Response;
  try {
    // manual: Access answers a lapsed session with a redirect to its login page, which must read as « reconnexion »,
    // not be followed cross-origin into a CORS failure that looks like no network
    res = await fetchImpl(url, { ...init, redirect: "manual", credentials: "same-origin", cache: "no-store" });
  } catch {
    return { kind: "offline" };
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
    return { kind: "reauth" };
  }
  // a status first: a 5xx error page is HTML too, and is a server failure, not a lapsed login
  if (res.status >= 500) return { kind: "server", status: res.status };
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    return res.ok ? { kind: "reauth" } : { kind: "server", status: res.status };
  }
  if (!res.ok) return { kind: "server", status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "server", status: res.status };
  }
  return valid(body) ? { kind: "ok", body } : { kind: "server", status: res.status };
}

export function fetchSnapshot(fetchImpl: Fetcher): Promise<Outcome<Snapshot>> {
  return call(fetchImpl, "/api/state", { method: "GET" }, isSnapshot);
}

export function postOps(fetchImpl: Fetcher, ops: Op[]): Promise<Outcome<OpsAnswer>> {
  return call(fetchImpl, "/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) }, isOpsAnswer);
}
