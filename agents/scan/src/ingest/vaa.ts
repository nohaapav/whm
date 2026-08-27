import { pad } from "viem";

/**
 * A VAA's identity — `chainId/emitter/sequence`, the same form Wormhole's own API uses, so an id
 * here pastes straight into a wormholescan lookup.
 *
 * It is the only name both ends of a transfer share: the source knows it at publish, and the
 * destination echoes it when the message is consumed.
 *
 * @param wormholeId Emitting chain's Wormhole id.
 * @param emitter Emitter address, h160 or already 32 bytes.
 * @param sequence The emitter's sequence.
 */
export function vaaId(wormholeId: number, emitter: string, sequence: bigint): string {
  const hex = emitter.replace(/^0x/, "");
  const padded = hex.length === 64 ? hex : pad(`0x${hex}` as `0x${string}`, { size: 32 }).slice(2);
  return `${wormholeId}/${padded.toLowerCase()}/${sequence}`;
}
