/**
 * The hostnames that name this machine, as a URL's `hostname` spells them (an IPv6 address keeps its brackets). The
 * Worker honours the local Access bypass only for them (`isLocalRequest`), and the CLI and the probes send the service
 * token in cleartext only to them: nothing sent there crosses a network.
 */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname);
}
