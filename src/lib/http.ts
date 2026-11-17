/**
 * `fetch` resolved for call sites that may inject one.
 *
 * Never pass the global `fetch` around detached: browsers bind it to
 * the window and a bare `doFetch(...)` throws "Illegal invocation".
 */
export function fetcher(injected?: typeof fetch): typeof fetch {
  if (injected) return injected;
  return (input, init) => fetch(input, init);
}
