import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isLoopbackHost } from "../domain/loopback";

export interface AuthEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Local `wrangler dev` only, via .dev.vars or `--var`. Never in wrangler.jsonc, and honoured only on localhost. */
  DEV_SKIP_ACCESS?: string;
}

/**
 * The bypass holds only for a request this machine serves: a DEV_SKIP_ACCESS that reached a deployed Worker (a secret,
 * a dashboard variable) still leaves every request on a real hostname, workers.dev included, to the JWT check. The
 * hostname is the only local-only signal workerd gives (miniflare mocks `request.cf` and sets CF-Connecting-IP only when
 * the request lacks one), so a secret is kept off the deployed Worker by deploy:ci, which refuses any.
 */
export function isLocalRequest(request: Request): boolean {
  return isLoopbackHost(new URL(request.url).hostname);
}

export type Verifier = (request: Request, env: AuthEnv) => Promise<boolean>;

const remote = new Map<string, JWTVerifyGetKey>();
function remoteJwks(team: string): JWTVerifyGetKey {
  let keys = remote.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    remote.set(team, keys);
  }
  return keys;
}

export function makeAccessVerifier(getKeyFor: (team: string) => JWTVerifyGetKey = remoteJwks): Verifier {
  return async (request, env) => {
    if (env.DEV_SKIP_ACCESS === "1" && isLocalRequest(request)) return true;
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
    try {
      await jwtVerify(token, getKeyFor(env.ACCESS_TEAM_DOMAIN), {
        audience: env.ACCESS_AUD,
        issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      });
      return true;
    } catch {
      return false;
    }
  };
}
