// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import { ChainId } from "@certusone/wormhole-sdk";
import { Contract, ethers } from "ethers";

import logger from "./logger";
import { createTransferQueue, loadVaaFromWormholeApi, TransferTask } from "./common";

// Intents v2: Hydration settles WETH to Ethereum over NTT and publishes a forwarding instruction
// beside it. This relayer pairs the two and calls IntentReceiver.processOrder, which delivers the
// settlement, forwards it to the instruction's depositAddress, and reimburses the caller.
//
// Only the settlement is subscribed to. The instruction is derived from the source transaction on
// demand, so there is no pairing state to lose: the engine's missed-VAA worker and retry backoff
// recover an order on their own, and a retry rebuilds everything from the settlement alone.

// Hydration's Wormhole chain id. Absent from @certusone/wormhole-sdk, which predates the chain.
const HYDRATION_CHAIN = 73 as ChainId;

// WormholeTransceiver (WETH) on Hydration — publishes the settlement VAA `processOrder` delivers.
const NTT_TRANSCEIVER = (process.env.NTT_TRANSCEIVER || "").toLowerCase();

// IntentEmitter on Hydration — publishes the forwarding instruction beside each settlement.
const INTENT_EMITTER = (process.env.INTENT_EMITTER || "").toLowerCase();

// IntentReceiver proxy on Ethereum.
const INTENT_RECEIVER = (process.env.INTENT_RECEIVER || "").toLowerCase();

// quoter service that prices the relay fee (see agents/quoter).
const QUOTER_URL = process.env.QUOTER_URL || "http://localhost:8080";

// `processOrder` verifies a VAA, delivers through the transceiver, and makes two native transfers,
// so it costs well above a bare TokenBridge completion. Passed to the quoter so the fee reflects it.
const GAS_LIMIT = process.env.INTENT_GAS_LIMIT || "500000";

// Re-quote + retry an unprofitable order before dropping it — gas can fall within minutes, so a
// fee currently above the user's maxRelayFee may become payable shortly. Retries ride the relayer
// engine's Redis-backed delayed queue (exponential backoff), so they survive restarts and don't hold
// worker slots. The engine's strategy is `min(2^attemptsMade * baseDelayMs, maxDelayMs)`, so
// baseDelayMs=60_000 yields 2, 4, 8, 16, 32, 64 min between attempts. INTENT_RETRIES caps the
// attempt count, but the terminal condition is the VAA age check below.
const INTENT_RETRIES = Number(process.env.INTENT_RETRIES || 8);
const INTENT_RETRY_BASE_MS = Number(process.env.INTENT_RETRY_BASE_MS || 60_000);
const INTENT_RETRY_MAX_MS = Number(process.env.INTENT_RETRY_MAX_MS || 70 * 60_000);
const INTENT_MAX_VAA_AGE_MS = Number(process.env.INTENT_MAX_VAA_AGE_MS || 60 * 60_000);

const eth = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC || "https://eth.llamarpc.com");
const hydration = new ethers.providers.JsonRpcProvider(
  process.env.HYDRATION_RPC || "https://hydration-rpc.n.dwellir.com",
);
// Dedicated, reimbursed wallet — separate from the generic relayers (PRIVKEY).
const signer = new ethers.Wallet(process.env.INTENT_PRIVKEY, eth);

const intentReceiver = new Contract(
  INTENT_RECEIVER,
  [
    "function processOrder(bytes nttVaa, bytes instructionVaa, uint256 feeRequested) external",
    "error AlreadyRedeemed()",
    "error SequenceMismatch(uint64 instructed, uint64 settled)",
    "error NotFunded(uint256 required, uint256 available)",
    "error FeeExceedsCeiling()",
  ],
  signer,
);

// Wormhole core bridge log. Only `sender` is indexed, which is enough to pick our emitter's messages
// out of a receipt without knowing the core bridge's address.
const coreBridge = new ethers.utils.Interface([
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
]);
const LOG_MESSAGE_PUBLISHED = coreBridge.getEventTopic("LogMessagePublished");

// The transceiver also publishes init/peer broadcasts; only transfers carry this prefix.
const NTT_TRANSCEIVER_PAYLOAD_PREFIX = "9945ff10";

// TransceiverMessage wire format, as far as the manager's message id:
//   prefix(4) sourceManager(32) recipientManager(32) payloadLen(2) id(32) …
// `id` is bytes32(uint256(sequence)), so the uint64 sits in its last 8 bytes.
const SEQUENCE_OFFSET = 70 + 24;

/**
 * Whether a transceiver message is a transfer rather than a setup broadcast.
 *
 * @param vaa Parsed VAA from the transceiver emitter.
 * @returns True when the payload carries the NTT transfer prefix.
 */
function isNttTransfer(vaa: any): boolean {
  return (
    Buffer.from(vaa.payload).subarray(0, 4).toString("hex") === NTT_TRANSCEIVER_PAYLOAD_PREFIX
  );
}

/**
 * Read the NTT manager's sequence out of a settlement.
 *
 * This is the key the settlement and its instruction share, and the one `processOrder` re-checks
 * on-chain — not a Wormhole sequence.
 *
 * @param vaaPayload Raw transceiver payload bytes.
 * @returns The manager's message sequence.
 */
function settlementSequence(vaaPayload: Buffer): bigint {
  return Buffer.from(vaaPayload).readBigUInt64BE(SEQUENCE_OFFSET);
}

/**
 * Find the forwarding instruction the emitter published alongside a settlement.
 *
 * Both messages ride the same Hydration transaction, so the core bridge logged them into one
 * receipt. Matching on the manager sequence rather than taking the first log keeps a transaction
 * that ever carries more than one order honest.
 *
 * @param txHash   Hydration transaction that produced the settlement.
 * @param sequence Manager sequence read from the settlement.
 * @returns The instruction's Wormhole sequence and decoded terms, or null when this transaction
 *          published no matching instruction — i.e. the settlement is not an intent order.
 */
async function findInstruction(txHash: string, sequence: bigint) {
  const receipt = await hydration.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`no receipt for ${txHash} yet`);

  const emitterTopic = ethers.utils.hexZeroPad(INTENT_EMITTER, 32).toLowerCase();

  for (const log of receipt.logs) {
    if (log.topics[0] !== LOG_MESSAGE_PUBLISHED) continue;
    if ((log.topics[1] || "").toLowerCase() !== emitterTopic) continue;

    const { args } = coreBridge.parseLog(log);
    const [instructed, depositAddress, amount, maxRelayFee] = ethers.utils.defaultAbiCoder.decode(
      ["uint64", "address", "uint256", "uint256"],
      args.payload,
    );
    if (BigInt(instructed.toString()) !== sequence) continue;

    return {
      messageSequence: BigInt(args.sequence.toString()),
      depositAddress,
      amount: BigInt(amount.toString()),
      maxRelayFee: BigInt(maxRelayFee.toString()),
    };
  }

  return null;
}

/**
 * Fetch the relay fee for forwarding on Ethereum from the quoter service.
 *
 * Requests `marginBps=0` — the relayer asks its real cost; the headroom buffer lives on the user's
 * `maxRelayFee` (sized by the UI), not on the relayer's ask, so the two don't double-count. The fee
 * is native ETH, since that is what the receiver holds and pays out.
 *
 * @returns The fee to pass as `feeRequested`, in wei.
 */
async function quoteRelayFee(): Promise<bigint> {
  const res = await fetch(
    `${QUOTER_URL}/relay-fee?chain=ethereum&feeAsset=native&gasLimit=${GAS_LIMIT}&marginBps=0`,
  );
  if (!res.ok) throw new Error(`quoter ${res.status}: ${await res.text()}`);
  const { feeRequested } = await res.json();
  return BigInt(feeRequested);
}

/**
 * Fetch the signed instruction VAA, over gRPC first and Wormholescan second.
 *
 * The two paths are independent, and this is the one leg that isn't handed to us by the spy — a
 * settlement is unforwardable without it, so it's worth not depending on a single source.
 *
 * @param ctx      Relayer context, for its gRPC-backed fetchVaa.
 * @param sequence The instruction's Wormhole sequence on the emitter.
 * @returns The signed VAA bytes.
 */
async function fetchInstructionVaa(ctx: any, sequence: bigint): Promise<Buffer> {
  const emitterHex = ethers.utils.hexZeroPad(INTENT_EMITTER, 32).slice(2);

  try {
    const vaa = await ctx.fetchVaa(HYDRATION_CHAIN, Buffer.from(emitterHex, "hex"), sequence);
    return vaa.bytes;
  } catch (e) {
    ctx.logger?.info(`fetchVaa failed for instruction ${sequence}, trying Wormholescan`);
    const { vaaBytes } = await loadVaaFromWormholeApi(
      Number(HYDRATION_CHAIN),
      emitterHex,
      sequence,
    );
    return vaaBytes;
  }
}

/**
 * Subscribe to a Hydration emitter.
 *
 * `chain().address()` runs the emitter through the engine's `encodeEmitterAddress`, which throws on
 * chain 73 — relayer-engine's SDK predates Hydration. For an EVM chain that encoding is just the
 * address left-padded to 32 bytes, so register the handler under that key directly; `spyFilters()`
 * reads the same map, and the rest of the engine degrades gracefully on an unrecognised chain id.
 *
 * @param app     The relayer app to register on.
 * @param emitter Emitter contract address on Hydration.
 * @param handler Middleware to run for that emitter's VAAs.
 */
function onEmitter(app: any, emitter: string, handler: any) {
  const key = ethers.utils.hexZeroPad(emitter, 32).slice(2).toLowerCase();
  app.chain(HYDRATION_CHAIN)._addressHandlers[key] = handler;
}

(async function main() {
  for (const [name, value] of Object.entries({ NTT_TRANSCEIVER, INTENT_EMITTER, INTENT_RECEIVER })) {
    if (!value) throw new Error(`${name} is required`);
  }

  const queue = createTransferQueue(eth, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Forwarding settlement (feeRequested ${task.feeRequested})`);
    const feeData = await eth.getFeeData();
    const overrides = { nonce, maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: 1 };

    const args = [task.vaa.bytes, task.instructionVaa, task.feeRequested];
    await intentReceiver.callStatic.processOrder(...args, { nonce });
    const tx = await intentReceiver.processOrder(...args, overrides);
    await tx.wait();
    return tx.hash;
  });

  const currentNonce = await queue.initNonce();
  logger.info(`Intent relayer starting`);
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);
  logger.info(`NttTransceiver (Hydration) ${NTT_TRANSCEIVER}`);
  logger.info(`IntentEmitter (Hydration) ${INTENT_EMITTER}`);
  logger.info(`IntentReceiver (Ethereum) ${INTENT_RECEIVER}`);
  logger.info(`Quoter ${QUOTER_URL}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(Environment.MAINNET, {
    name: process.env.INTENT_APP_NAME || `intent-relayer`,
    logger,
    spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
    redis: {
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT) || 6379,
    },
    // Total attempts per settlement. A handler that throws (unprofitable / quoter down / source tx
    // not yet resolvable) is rescheduled with exponential backoff (see retryBackoffOptions). The VAA
    // age cap in the handler is the real terminator; this is a hard ceiling so nothing sticks.
    workflows: { retries: INTENT_RETRIES },
    retryBackoffOptions: {
      baseDelayMs: INTENT_RETRY_BASE_MS,
      maxDelayMs: INTENT_RETRY_MAX_MS,
    },
    missedVaaOptions: {
      startingSequenceConfig: {
        [HYDRATION_CHAIN]: BigInt(process.env.HYDRATION_FROM_SEQ || 0),
      },
    },
  });

  onEmitter(app, NTT_TRANSCEIVER, async (ctx, next) => {
    const { vaa, sourceTxHash } = ctx;
    const ctxLogger = ctx.logger.child({
      sourceTxHash,
      sequence: vaa.sequence.toString(),
    });

    if (!isNttTransfer(vaa)) {
      ctxLogger.info("Ignoring non-transfer transceiver message");
      return next();
    }

    // Wormholescan serves chain-73 hashes unprefixed: the engine only adds 0x for chains its SDK
    // recognises as EVM. Missing entirely means the indexer hasn't caught up — throw so we retry.
    if (!sourceTxHash) throw new Error("source tx hash unavailable; retrying");
    const txHash = sourceTxHash.startsWith("0x") ? sourceTxHash : `0x${sourceTxHash}`;

    const sequence = settlementSequence(vaa.payload);

    // A malformed settlement is permanent, so drop it rather than retry.
    let instruction;
    try {
      instruction = await findInstruction(txHash, sequence);
    } catch (e) {
      ctxLogger.info(`Instruction lookup for ${sequence} failed: ${e.message || e}; retrying`);
      throw e;
    }

    // The transceiver carries all WETH traffic off Hydration, so most settlements are not ours.
    if (!instruction) {
      ctxLogger.info(`Settlement ${sequence} has no instruction; not an intent order`);
      return next();
    }

    const { messageSequence, depositAddress, amount, maxRelayFee } = instruction;

    // Terminal condition: stop retrying once the VAA is older than the cap — gas is unlikely to
    // recover meaningfully past this point and the quote has expired. Ack (return, don't throw) so
    // the engine marks the job complete instead of scheduling another backoff retry.
    const ageMs = Date.now() - vaa.timestamp * 1000;
    if (ageMs > INTENT_MAX_VAA_AGE_MS) {
      ctxLogger.info(
        `Drop stale settlement ${sequence}: VAA age ${Math.round(ageMs / 60_000)}m > ` +
          `${Math.round(INTENT_MAX_VAA_AGE_MS / 60_000)}m`,
      );
      return next();
    }

    const attempt = ctx.storage?.job?.attempts ?? 0;

    // Re-quote on every delivery; a transient quoter failure throws and reschedules.
    const feeRequested = await quoteRelayFee();

    // Still above the user's ceiling: throw so the engine retries with backoff (2, 4, 8, 16, 32,
    // 64 min). Gas often settles within minutes of a spike; the age cap above stops us eventually.
    if (feeRequested > maxRelayFee) {
      throw new Error(
        `settlement ${sequence} unprofitable (attempt ${attempt}/${INTENT_RETRIES}): ` +
          `feeRequested ${feeRequested} > maxRelayFee ${maxRelayFee}; retrying with backoff`,
      );
    }

    const instructionVaa = await fetchInstructionVaa(ctx, messageSequence);

    ctxLogger.info(
      `Settlement ${sequence} (${amount} wei) → ${depositAddress}: instruction ${messageSequence}, ` +
        `feeRequested ${feeRequested} ≤ maxRelayFee ${maxRelayFee} (attempt ${attempt}/${INTENT_RETRIES})`,
    );
    queue.addToQueue({
      vaa,
      instructionVaa,
      type: "intent",
      feeRequested: feeRequested.toString(),
      logger: ctxLogger,
      next,
    });
  });

  await app.listen();
})();
