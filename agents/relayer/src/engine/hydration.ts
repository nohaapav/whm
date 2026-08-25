import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { hydration, HYDRATION_EVM_CHAIN_ID } from "../chains";
import { hydrationFees } from "../utils/fees";

export interface HydrationClients {
  account: Account;
  publicClient: PublicClient;
  wallet: WalletClient;
}

/**
 * Connect to Hydration's EVM and assert the RPC is the chain we think it is.
 *
 * @param rpcUrl Hydration EVM RPC.
 * @param key Signing key.
 * @returns Account plus read and write clients.
 * @throws When the RPC reports a different chain id.
 */
export async function hydrationClients(
  rpcUrl: string,
  key: `0x${string}`,
): Promise<HydrationClients> {
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: hydration, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: hydration, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`RPC_HYDRATION returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }

  return { account, publicClient, wallet };
}

/**
 * Submit `receiveMessage(vaa)` to a Hydration contract under a caller-owned nonce.
 *
 * Simulated first so a revert surfaces as a named error before a nonce is spent — the queue then
 * classifies it rather than burning gas.
 *
 * @param clients Hydration account and clients.
 * @param abi ABI carrying `receiveMessage(bytes)`.
 * @param to Contract that consumes the VAA.
 * @param vaaBytes The guardian-signed VAA.
 * @param nonce Nonce to submit under.
 * @returns The transaction hash.
 */
export async function receiveMessage(
  clients: HydrationClients,
  abi: Abi,
  to: Address,
  vaaBytes: Buffer,
  nonce: number,
): Promise<Hash> {
  const { account, publicClient, wallet } = clients;
  const args = [`0x${vaaBytes.toString("hex")}`] as const;

  await publicClient.simulateContract({
    address: to,
    abi,
    functionName: "receiveMessage",
    args,
    account,
  });

  // Hydration wants no priority fee, and some compatible RPCs omit
  // eth_maxPriorityFeePerGas — see utils/fees.
  const fees = await hydrationFees(publicClient);
  const call = {
    address: to,
    abi,
    functionName: "receiveMessage",
    args,
    nonce,
    chain: hydration,
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
