import { pad, type Address } from "viem";

/**
 * NTT transceiver payload parsing. Shared by every feature that reads an NTT settlement, whichever
 * direction it travels.
 *
 * TransceiverMessage wire format, as far as the manager's message id:
 *
 *   offset  size  field
 *        0     4  prefix
 *        4    32  sourceNttManagerAddress
 *       36    32  recipientNttManagerAddress
 *       68     2  nttManagerPayload length
 *       70    32  id
 *
 * `id` is `bytes32(uint256(sequence))`, so the uint64 sits in its last 8 bytes. This mirrors
 * `NttPayload.sequenceOf` in contracts/src/ntt, which is what IntentReceiver re-checks on-chain.
 */

/** Only transfers carry this prefix; the same emitter also publishes init/peer broadcasts. */
export const NTT_TRANSFER_PREFIX = "9945ff10";

const RECIPIENT_MANAGER_OFFSET = 36;
const SEQUENCE_OFFSET = 70 + 24;

/**
 * Whether a transceiver message is a transfer rather than a setup broadcast.
 *
 * @param payload Raw transceiver payload bytes.
 */
export function isNttTransfer(payload: Buffer): boolean {
  return payload.subarray(0, 4).toString("hex") === NTT_TRANSFER_PREFIX;
}

/**
 * The NTT manager's sequence for a settlement.
 *
 * This is the key a settlement and its forwarding instruction share. It is not a Wormhole sequence —
 * those are per-emitter and unrelated.
 *
 * @param payload Raw transceiver payload bytes.
 */
export function settlementSequence(payload: Buffer): bigint {
  return payload.readBigUInt64BE(SEQUENCE_OFFSET);
}

/**
 * Whether a settlement is addressed to a given destination NTT manager.
 *
 * One transceiver emitter serves one manager per token, but a relayer subscribing to several routes
 * still has to tell them apart before submitting.
 *
 * @param payload Raw transceiver payload bytes.
 * @param manager Expected destination NttManager address.
 */
export function isForManager(payload: Buffer, manager: Address): boolean {
  const recipient = payload
    .subarray(RECIPIENT_MANAGER_OFFSET, RECIPIENT_MANAGER_OFFSET + 32)
    .toString("hex");
  return recipient === pad(manager, { size: 32 }).slice(2).toLowerCase();
}
