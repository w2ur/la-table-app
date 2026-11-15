import type { ComponentChildren } from "preact";
import { go } from "./nav";
import { href, type Route } from "./route";

/**
 * A row or link that opens a screen or sheet as an entry the app records (nav.ts `go`), so closing it goes back. A
 * modified click (new tab, new window) keeps the browser's own behaviour.
 */
export function RouteLink({ route, class: className, children }: { route: Route; class?: string; children: ComponentChildren }) {
  const open = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(route);
  };
  return <a class={className} href={href(route)} onClick={open}>{children}</a>;
}
