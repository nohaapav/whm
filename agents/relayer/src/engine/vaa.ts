import logger from "../logger";
import type { ChainId, RelayerCtx } from "../types";

const WORMHOLESCAN = "https://api.wormholescan.io/api/v1";

// Wormholescan rate-limits anonymous callers; the key raises the ceiling when one is configured.
const apiKey = process.env.WORMHOLE_API_KEY;

/**
 * Load a signed VAA from the Wormholescan REST API.
 *
 * An independent path to the engine's `ctx.fetchVaa`, which reaches the guardians over gRPC. Either
 * can lag or fail while the other serves, so this doubles as a fallback for the one leg the spy does
 * not hand us.
 *
 * @param chain Wormhole chain id of the emitter.
 * @param emitter Emitter address, 32-byte hex without `0x`.
 * @param sequence The emitter's Wormhole sequence.
 * @returns Signed VAA bytes plus the source transaction hash.
 */
export async function loadVaa(
  chain: ChainId,
  emitter: string,
  sequence: bigint | number,
): Promise<{ bytes: Buffer; sourceTxHash?: string }> {
  const res = await fetch(`${WORMHOLESCAN}/vaas/${chain}/${emitter}/${sequence}`, {
    headers: apiKey ? { "X-API-KEY": apiKey } : {},
  });
  if (!res.ok) throw new Error(`wormholescan ${res.status} for ${chain}/${emitter}/${sequence}`);

  const body = (await res.json()) as { data?: { vaa: string; txHash?: string } };
  if (!body.data) throw new Error(`no VAA at ${chain}/${emitter}/${sequence}`);

  return {
    bytes: Buffer.from(body.data.vaa, "base64"),
    sourceTxHash: body.data.txHash,
  };
}

/**
 * Fetch a signed VAA over gRPC first, falling back to Wormholescan.
 *
 * @param ctx Engine context, for its gRPC-backed fetchVaa.
 * @param chain Wormhole chain id of the emitter.
 * @param emitter Emitter address, 32-byte hex without `0x`.
 * @param sequence The emitter's Wormhole sequence.
 * @returns Signed VAA bytes.
 */
export async function fetchVaa(
  ctx: Pick<RelayerCtx, "fetchVaa">,
  chain: ChainId,
  emitter: string,
  sequence: bigint,
): Promise<Buffer> {
  try {
    // `chain` is cast because the engine types it as its own SDK's ChainId enum, which has no
    // member for Hydration. The value is only forwarded to the guardian RPC, which takes a number.
    const vaa = await ctx.fetchVaa(chain as never, Buffer.from(emitter, "hex"), sequence);
    return Buffer.from(vaa.bytes);
  } catch {
    logger.info(`fetchVaa failed for ${chain}/${emitter}/${sequence}, trying Wormholescan`);
    const { bytes } = await loadVaa(chain, emitter, sequence);
    return bytes;
  }
}

/**
 * Wormholescan serves chain-73 hashes unprefixed: relayer-engine only adds `0x` for chains its SDK
 * recognises as EVM, and it predates Hydration.
 *
 * @param hash Source tx hash as the engine resolved it.
 * @returns The same hash, 0x-prefixed.
 */
export function normalizeTxHash(hash: string): `0x${string}` {
  return (hash.startsWith("0x") ? hash : `0x${hash}`) as `0x${string}`;
}
