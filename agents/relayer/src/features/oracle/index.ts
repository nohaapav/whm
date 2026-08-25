import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import logger from "../../logger";
import { engineConfig } from "../../config/env";
import { HYDRATION_EVM_CHAIN_ID } from "../../config/hydration";
import { oracleConfig } from "../../config/oracle";
import { makeApp } from "../../engine/app";
import { createQueue } from "../../engine/queue";
import { hydrationFees } from "../../utils/fees";
import type { Feature, Next, RelayerCtx } from "../../types";

import { CHAIN, ORACLE_ROUTES, type OracleRoute } from "./routes";

const receiverAbi = parseAbi(["function receiveMessage(bytes vaa) external"]);

const hydrationChain = defineChain({
  id: HYDRATION_EVM_CHAIN_ID,
  name: "Hydration",
  nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/**
 * Relays oracle price VAAs into Hydration. Each source chain's VAAs go to that source's own
 * OracleReceiver, which verifies the emitter and writes the price in one call.
 */
export function oracleFeature(): Feature {
  return { name: "oracle", start };
}

async function start(): Promise<void> {
  const cfg = oracleConfig();
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
  logger.info("Oracle relayer starting");
  logger.info(`  account: ${account.address} (nonce ${nonce})`);
  for (const route of ORACLE_ROUTES) {
    logger.info(`  ${route.source} ${route.sourceEmitter} -> ${route.receiver}`);
  }

  /** Submit a price VAA to its source's receiver. */
  async function deliver(route: OracleRoute, vaaBytes: Buffer, nonce: number) {
    const args = [`0x${vaaBytes.toString("hex")}`] as const;

    await publicClient.simulateContract({
      address: route.receiver,
      abi: receiverAbi,
      functionName: "receiveMessage",
      args,
      account,
    });

    // Hydration wants no priority fee, and some compatible RPCs omit
    // eth_maxPriorityFeePerGas — see utils/fees.
    const fees = await hydrationFees(publicClient);
    const call = {
      address: route.receiver,
      abi: receiverAbi,
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

  async function handle(route: OracleRoute, ctx: RelayerCtx, next: Next): Promise<void> {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger!.child({
      source: route.source,
      sourceTxHash,
      sequence: vaa.sequence.toString(),
    });

    queue.add({
      label: `${route.source} oracle`,
      logger: log,
      next,
      submit: (n) => deliver(route, vaa.bytes, n),
    });
  }

  const app = makeApp(engineConfig(), {
    name: cfg.name,
    retries: cfg.retries,
    startingSequence: {
      [CHAIN.solana]: cfg.fromSequence.solana,
      [CHAIN.ethereum]: cfg.fromSequence.ethereum,
    },
  });

  for (const route of ORACLE_ROUTES) {
    app
      .chain(route.sourceChain as never)
      .address(route.sourceEmitter, ((ctx: RelayerCtx, next: Next) =>
        handle(route, ctx, next)) as never);
  }

  await app.listen();
}
