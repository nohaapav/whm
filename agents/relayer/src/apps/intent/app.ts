import { createPublicClient, createWalletClient, http, pad, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { alerts, engineConfig, privateKey } from "../../config";
import { createApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import { isNttTransfer, settlementSequence } from "../../engine/ntt";
import { createQueue } from "../../engine/queue";
import { fetchVaa, normalizeTxHash } from "../../engine/vaa";
import logger from "../../logger";
import type { Next, RelayerCtx } from "../../types";

import { receiverAbi } from "./abi";
import {
  APP_NAME,
  FROM_SEQUENCE,
  MAX_VAA_AGE_MS,
  QUOTER_URL,
  RETRIES,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RPC_ETHEREUM,
  RPC_HYDRATION,
} from "./config";
import { findInstruction } from "./instruction";
import { quoteRelayFee } from "./quote";
import { route } from "./routes";

/**
 * Intents — Hydration settles WETH to Ethereum over NTT and publishes a forwarding instruction
 * beside it. This pairs the two and calls IntentReceiver.processOrder, which delivers the
 * settlement, forwards it to the deposit address, and reimburses the caller.
 *
 * Only the settlement is subscribed to. The instruction is derived from the source transaction on
 * demand, so there is no pairing state to lose: the engine's missed-VAA worker and retry backoff
 * recover an order on their own, and a retry rebuilds everything from the settlement alone.
 */
async function start(): Promise<void> {
  const { transceiver, emitter, receiver } = route();
  const account = privateKeyToAccount(privateKey());

  const eth = createPublicClient({ chain: mainnet, transport: http(RPC_ETHEREUM) });
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC_ETHEREUM) });
  // Read-only: the source tx receipt the forwarding instruction is found in.
  const hydration = createPublicClient({ transport: http(RPC_HYDRATION) });

  const queue = createQueue({
    publicClient: eth,
    account,
    ...alerts(),
  });

  // Constant per process; the instruction VAA is always addressed to this emitter.
  const emitterHex = pad(emitter, { size: 32 }).slice(2);

  const nonce = await queue.init();
  logger.info(`  account:     ${account.address} (nonce ${nonce})`);
  logger.info(`  transceiver: ${transceiver} @ hydration`);
  logger.info(`  emitter:     ${emitter} @ hydration`);
  logger.info(`  receiver:    ${receiver} @ ethereum`);
  logger.info(`  quoter:      ${QUOTER_URL}`);

  /**
   * Deliver a settlement and forward it, in one call. Simulated first so a revert surfaces as a
   * named error before a nonce is spent — the queue then classifies it (already redeemed, sequence
   * mismatch, underfunded) rather than burning gas.
   */
  async function forward(nttVaa: Buffer, instructionVaa: Buffer, fee: bigint, nonce: number) {
    const args = [
      `0x${nttVaa.toString("hex")}`,
      `0x${instructionVaa.toString("hex")}`,
      fee,
    ] as const;

    await eth.simulateContract({
      address: receiver,
      abi: receiverAbi,
      functionName: "processOrder",
      args,
      account,
    });

    return wallet.writeContract({
      address: receiver,
      abi: receiverAbi,
      functionName: "processOrder",
      args,
      nonce,
      chain: mainnet,
      account,
    });
  }

  /**
   * Decide what to do with one settlement VAA.
   *
   * Two ways out besides forwarding, and the difference matters: `skip` acks the workflow because
   * nothing a retry could change — the settlement is not ours, or it is past saving. Throwing hands
   * it back for another attempt with backoff, for the cases that do resolve on their own (the
   * indexer catching up, gas falling below the user's ceiling).
   */
  async function handle(ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger!.child({ sourceTxHash, sequence: vaa.sequence.toString() });

    if (!isNttTransfer(vaa.payload)) {
      log.info("Ignoring non-transfer NTT transceiver message");
      return next();
    }

    if (!sourceTxHash) {
      log.warn("Source tx hash unavailable; retrying...");
      throw new Error("Source tx hash unavailable; retrying...");
    }

    const sequence = settlementSequence(vaa.payload);
    const order = await findInstruction(
      hydration,
      emitter,
      normalizeTxHash(sourceTxHash) as Hash,
      sequence,
    );

    if (!order) {
      log.info(`Settlement ${sequence} carries no instruction`);
      return next();
    }

    // An order we could have delivered and did not — worth seeing.
    const ageMin = Math.round((Date.now() - vaa.timestamp * 1000) / 60_000);
    if (ageMin * 60_000 > MAX_VAA_AGE_MS) {
      log.info(`Order ${sequence} stale (${ageMin}m > ${MAX_VAA_AGE_MS / 60_000}m)`);
      return next();
    }

    const attempt = ctx.storage?.job?.attempts ?? 0;
    const fee = await quoteRelayFee();
    if (fee > order.maxRelayFee) {
      const reason =
        `Order ${sequence} unprofitable (attempt ${attempt}/${RETRIES}): ` +
        `fee ${fee} > ceiling ${order.maxRelayFee}; retrying with backoff`;
      log.warn(reason);
      throw new Error(reason);
    }

    const instructionVaa = await fetchVaa(
      ctx,
      WORMHOLE.hydration,
      emitterHex,
      order.messageSequence,
    );

    log.info(
      `Order ${sequence}: ${order.amount} wei -> ${order.depositAddress}, ` +
        `fee ${fee} <= ${order.maxRelayFee} (attempt ${attempt}/${RETRIES})`,
    );

    queue.add({
      label: `order ${sequence}`,
      logger: log,
      next,
      submit: (n) => forward(vaa.bytes, instructionVaa, fee, n),
    });
  }

  const app = createApp(engineConfig(), {
    name: APP_NAME,
    retries: RETRIES,
    backoff: { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS },
    startingSequence: FROM_SEQUENCE,
  });

  onEmitter(app, WORMHOLE.hydration, transceiver, handle as never);

  await app.listen();
}

boot("intent", start);
