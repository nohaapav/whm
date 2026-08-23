import { createPublicClient, createWalletClient, http, pad, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import logger from "../../logger";
import { engineConfig } from "../../config/env";
import { HYDRATION_CHAIN, intentConfig } from "../../config/intent";
import { makeApp } from "../../engine/app";
import { onEmitter } from "../../engine/emitter";
import { isNttTransfer, settlementSequence } from "../../engine/ntt";
import { createQueue } from "../../engine/queue";
import { fetchVaa, normalizeTxHash } from "../../engine/vaa";
import type { Feature, Next, RelayerCtx } from "../../types";

import { receiverAbi } from "./abi";
import { findInstruction } from "./instruction";
import { quoteRelayFee } from "./quote";

/**
 * Intents v2 — Hydration settles WETH to Ethereum over NTT and publishes a forwarding instruction
 * beside it. This pairs the two and calls IntentReceiver.processOrder, which delivers the
 * settlement, forwards it to the deposit address, and reimburses the caller.
 *
 * Only the settlement is subscribed to. The instruction is derived from the source transaction on
 * demand, so there is no pairing state to lose: the engine's missed-VAA worker and retry backoff
 * recover an order on their own, and a retry rebuilds everything from the settlement alone.
 */
export function intentFeature(): Feature {
  return { name: "intent", start };
}

async function start(): Promise<void> {
  const cfg = intentConfig();
  const account = privateKeyToAccount(cfg.privateKey);

  const eth = createPublicClient({ chain: mainnet, transport: http(cfg.ethRpc) });
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(cfg.ethRpc) });
  // Read-only: the source tx receipt the forwarding instruction is found in.
  const hydration = createPublicClient({ transport: http(cfg.hydrationRpc) });

  const queue = createQueue({
    publicClient: eth,
    account,
    discordWebhook: cfg.discordWebhook,
    warnMultiplier: cfg.warnMultiplier,
  });

  // Constant per process; the instruction VAA is always addressed to this emitter.
  const emitterHex = pad(cfg.emitter, { size: 32 }).slice(2);

  const nonce = await queue.init();
  logger.info("Intent relayer starting");
  logger.info(`  account:     ${account.address} (nonce ${nonce})`);
  logger.info(`  transceiver: ${cfg.transceiver} @ hydration`);
  logger.info(`  emitter:     ${cfg.emitter} @ hydration`);
  logger.info(`  receiver:    ${cfg.receiver} @ ethereum`);
  logger.info(`  quoter:      ${cfg.quoterUrl}`);

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
      address: cfg.receiver,
      abi: receiverAbi,
      functionName: "processOrder",
      args,
      account,
    });

    return wallet.writeContract({
      address: cfg.receiver,
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
      throw new Error("Source tx hash unavailable; retrying...");
    }

    const sequence = settlementSequence(vaa.payload);
    const order = await findInstruction(
      hydration,
      cfg.emitter,
      normalizeTxHash(sourceTxHash) as Hash,
      sequence,
    );

    if (!order) {
      log.info(`Settlement ${sequence} carries no instruction`);
      return next();
    }

    // An order we could have delivered and did not — worth seeing.
    const ageMin = Math.round((Date.now() - vaa.timestamp * 1000) / 60_000);
    if (ageMin * 60_000 > cfg.maxVaaAgeMs) {
      log.info(`Order ${sequence} stale (${ageMin}m > ${cfg.maxVaaAgeMs / 60_000}m)`);
      return next();
    }

    const attempt = ctx.storage?.job?.attempts ?? 0;
    const fee = await quoteRelayFee(cfg);
    if (fee > order.maxRelayFee) {
      throw new Error(
        `Order ${sequence} unprofitable (attempt ${attempt}/${cfg.retries}): ` +
          `fee ${fee} > ceiling ${order.maxRelayFee}; retrying with backoff`,
      );
    }

    const instructionVaa = await fetchVaa(ctx, HYDRATION_CHAIN, emitterHex, order.messageSequence);

    log.info(
      `Order ${sequence}: ${order.amount} wei -> ${order.depositAddress}, ` +
        `fee ${fee} <= ${order.maxRelayFee} (attempt ${attempt}/${cfg.retries})`,
    );

    queue.add({
      label: `order ${sequence}`,
      logger: log,
      next,
      submit: (n) => forward(vaa.bytes, instructionVaa, fee, n),
    });
  }

  const app = makeApp(engineConfig(), {
    name: cfg.name,
    retries: cfg.retries,
    backoff: { baseMs: cfg.retryBaseMs, maxMs: cfg.retryMaxMs },
    startingSequence: { [HYDRATION_CHAIN]: cfg.fromSequence },
  });

  onEmitter(app, HYDRATION_CHAIN, cfg.transceiver, handle as never);

  await app.listen();
}
