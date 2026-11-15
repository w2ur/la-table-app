/**
 * A throwaway Worker that measures, on Cloudflare, what Workers Free counts against its D1 budget per invocation:
 * `/serial?n=` runs n statements one call each, `/batches?n=` n batches of one statement, `/wide?n=` one batch of n
 * statements. Each answers how many calls completed and the error that stopped it. Deployed on workers.dev against a
 * scratch database by a one-off measurement, then deleted; it never touches la-table's database.
 */
interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get("n"));
    if (!Number.isInteger(n) || n < 1 || n > 2000) return Response.json({ ok: false, error: "n entre 1 et 2000" }, { status: 400 });
    const one = (i: number) => env.DB.prepare("SELECT ?1 AS i").bind(i);
    let done = 0;
    try {
      if (url.pathname === "/serial") for (; done < n; done++) await one(done).first();
      else if (url.pathname === "/batches") for (; done < n; done++) await env.DB.batch([one(done)]);
      else if (url.pathname === "/wide") { await env.DB.batch(Array.from({ length: n }, (_, i) => one(i))); done = n; }
      else return Response.json({ ok: false, error: "inconnu" }, { status: 404 });
      return Response.json({ ok: true, done });
    } catch (error) {
      return Response.json({ ok: false, done, error: error instanceof Error ? error.message : String(error) });
    }
  },
} satisfies ExportedHandler<Env>;
