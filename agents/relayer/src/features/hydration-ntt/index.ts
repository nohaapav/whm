import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import logger from "../../logger";
import { engineConfig } from "../../config/env";
import { HYDRATION_EVM_CHAIN_ID, hydrationConfig } from "../../config/hydration";
import { makeApp } from "../../engine/app";
import { isForManager, isNttTransfer } from "../../engine/ntt";
import { createQueue } from "../../engine/queue";
import { hydrationFees } from "../../utils/fees";
import type { Feature, Next, RelayerCtx } from "../../types";

import { CHAIN, NTT_ROUTES, type NttRoute } from "./routes";

const transceiverAbi = parseAbi([
  "function receiveMessage(bytes encodedMessage) external",
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
]);

const hydrationChain = defineChain({
  id: HYDRATION_EVM_CHAIN_ID,
  name: "Hydration",
  nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/**
 * Redeems Wormhole NTT transfers into Hydration from every configured origin chain. Each route's
 * transfer VAA is submitted to that route's Hydration transceiver.
 */
export function hydrationNttFeature(): Feature {
  return { name: "hydration-ntt", start };
}

async function start(): Promise<void> {
  const cfg = hydrationConfig();
  const account = privateKeyToAccount(cfg.privateKey);

  const publicClient = createPublicClient({ chain: hydrationChain, transport: http(cfg.rpc) });
  const wallet = createWalletClient({ account, chain: hydrationChain, transport: http(cfg.rpc) });

  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`HYDRATION_RPC returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }

  const queue = createQueue({
    publicClient,
    account,
    discordWebhook: cfg.discordWebhook,
    warnMultiplier: cfg.warnMultiplier,
  });

  const nonce = await queue.init();
  logger.info("Hydration NTT relayer starting");
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  logger.info(`  watching ${NTT_ROUTES.length} NTT routes`);

  /** Submit a transfer VAA to its route's Hydration transceiver. */
  async function deliver(route: NttRoute, vaaBytes: Buffer, nonce: number) {
    const args = [`0x${vaaBytes.toString("hex")}`] as const;

    await publicClient.simulateContract({
      address: route.transceiver,
      abi: transceiverAbi,
      functionName: "receiveMessage",
      args,
      account,
    });

    // Hydration wants no priority fee, and some compatible RPCs omit
    // eth_maxPriorityFeePerGas — see utils/fees.
    const fees = await hydrationFees(publicClient);
    const call = {
      address: route.transceiver,
      abi: transceiverAbi,
      functionName: "receiveMessage",
      args,
      nonce,
      chain: hydrationChain,
      account,
    } as const;

    return fees.kind === "legacy"
      ? wallet.writeContract({ ...call, gasPrice: fees.gasPrice })
      : wallet.writeContract({
          ...call,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
  }

  async function handle(route: NttRoute, ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger!.child({
      token: route.token,
      sourceTxHash,
      emitterChain: vaa.emitterChain,
      sequence: vaa.sequence.toString(),
    });

    if (!isNttTransfer(vaa.payload)) {
      log.info("Ignoring non-transfer NTT transceiver message");
      return next();
    }

    if (!isForManager(vaa.payload, route.manager)) {
      log.info("Ignoring NTT transfer for another destination manager");
      return next();
    }

    queue.add({
      label: `${route.token} transfer`,
      logger: log,
      next,
      submit: (n) => deliver(route, vaa.bytes, n),
    });
  }

  const app = makeApp(engineConfig(), {
    name: cfg.name,
    retries: cfg.retries,
    startingSequence: {
      [CHAIN.ethereum]: cfg.fromSequence.ethereum,
      [CHAIN.base]: cfg.fromSequence.base,
      [CHAIN.solana]: cfg.fromSequence.solana,
      [CHAIN.sui]: cfg.fromSequence.sui,
    },
  });

  for (const route of NTT_ROUTES) {
    app
      .chain(route.sourceChain as never)
      .address(route.sourceEmitter, ((ctx: RelayerCtx, next: Next) =>
        handle(route, ctx, next)) as never);
  }

  await app.listen();
}
