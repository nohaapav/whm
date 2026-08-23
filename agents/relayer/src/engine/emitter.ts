import { pad, type Address } from "viem";

import type { ChainId, RelayerApp } from "../types";

/**
 * Subscribe to an emitter, bypassing the engine's chain lookup.
 *
 * `app.chain(id).address(addr)` runs the address through relayer-engine's `encodeEmitterAddress`,
 * which throws `Unrecognized wormhole chainId` for anything its bundled SDK predates — Hydration
 * (73) included. For an EVM chain that encoding is only the address left-padded to 32 bytes, so the
 * handler is registered under that key directly. `spyFilters()` reads the same map, so the
 * subscription registers itself; `process()` looks handlers up by the identical hex form.
 *
 * Everything else in the engine degrades gracefully on an unknown chain id: the TokenBridge
 * middleware skips it, no provider is built for it, and only a missed-VAA metrics label reads
 * `undefined`.
 *
 * @param app The engine app to register on.
 * @param chain Wormhole chain id of the emitter.
 * @param emitter Emitter contract address.
 * @param handler Middleware to run for that emitter's VAAs.
 */
export function onEmitter(
  app: RelayerApp,
  chain: ChainId,
  emitter: Address,
  handler: (ctx: never, next: () => Promise<void>) => Promise<void>,
): void {
  const key = pad(emitter, { size: 32 }).slice(2).toLowerCase();
  const router = app.chain(chain as never) as unknown as {
    _addressHandlers: Record<string, unknown>;
  };
  router._addressHandlers[key] = handler;
}
