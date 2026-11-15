import { createApp, type Env } from "./app";
import { makeAccessVerifier } from "./auth";

export type { Env };

const app = createApp({ verify: makeAccessVerifier() });

export default {
  fetch: (request: Request, env: Env) => app.fetch(request, env),
} satisfies ExportedHandler<Env>;
