/**
 * Node's native fetch, captured before anything else loads.
 *
 * `@wormhole-foundation/relayer-engine` pulls in cross-fetch, whose node polyfill assigns
 * `globalThis.fetch` at import time. That polyfill wraps node-fetch 2, whose `Response.body` is a
 * Node `Readable` rather than a WHATWG `ReadableStream` — so `response.body.getReader()` throws, and
 * every viem HTTP request fails. viem takes no per-transport fetch, so the global is the only lever.
 *
 * This module must be imported first: its body runs while the global is still native.
 */
const nativeFetch = globalThis.fetch;

/** Put the native fetch back, after the SDK's import-time polyfill has replaced it. */
export function restoreNativeFetch(): void {
  if (nativeFetch) globalThis.fetch = nativeFetch;
}
