import "dotenv/config";

import { isAddress, isHex, parseEventLogs } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import quoteEmitterJson from "../../out/IntentQuoteEmitter.sol/IntentQuoteEmitter.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

// IntentCodec.KIND_WITHDRAW / KIND_INTENTS_ACCOUNT.
const KINDS = { withdraw: 0, account: 1 } as const;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address"); // IntentQuoteEmitter proxy
  const quoteId = requiredArg("--quoteId"); // bytes32 namespace, unique per schedule
  const destinationAsset = requiredArg("--destinationAsset"); // e.g. nep141:zec.omft.near
  const recipient = requiredArg("--recipient"); // final destination — what the path protects
  const maxSlippageBps = Number(optionalArg("--maxSlippageBps") ?? "50");
  const kindArg = (optionalArg("--recipientKind") ?? "withdraw") as keyof typeof KINDS;

  if (!isAddress(address)) throw new Error("Invalid --address (IntentQuoteEmitter).");
  if (!isHex(quoteId) || quoteId.length !== 66)
    throw new Error("Invalid --quoteId (expected bytes32).");
  if (!(kindArg in KINDS))
    throw new Error(`Invalid --recipientKind: ${kindArg} (withdraw | account).`);
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 65535)
    throw new Error("Invalid --maxSlippageBps.");
  if (!destinationAsset) throw new Error("--destinationAsset must not be empty.");
  if (!recipient) throw new Error("--recipient must not be empty.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    order: {
      quoteId: quoteId as `0x${string}`,
      maxSlippageBps,
      recipientKind: KINDS[kindArg],
      destinationAsset,
      recipient,
    },
  };
}

const wormholeAbi = [
  {
    name: "messageFee",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function main(): Promise<void> {
  const cfg = getConfig();
  const { publicClient, walletClient, account } = getWallet(cfg.rpcUrl, cfg.chainId, cfg.privateKey);
  const { abi } = quoteEmitterJson as ifs.ContractArtifact;

  console.log("IntentEmitter:  ", cfg.address);
  console.log("publisher:      ", account.address);
  console.log("quoteId:        ", cfg.order.quoteId);
  console.log("destinationAsset:", cfg.order.destinationAsset);
  console.log("recipient:      ", cfg.order.recipient);
  console.log("recipientKind:  ", cfg.order.recipientKind);
  console.log("maxSlippageBps: ", cfg.order.maxSlippageBps);

  // The path is the hash of the terms, so compute it before publishing: this is the MPC derivation
  // path the NEAR account is derived from, and deposits go to an address derived from it.
  const [authPath, terms] = (await Promise.all([
    publicClient.readContract({
      address: cfg.address,
      abi,
      functionName: "computeAuthPath",
      args: [cfg.order],
    }),
    publicClient.readContract({
      address: cfg.address,
      abi,
      functionName: "computeTerms",
      args: [cfg.order],
    }),
  ])) as [`0x${string}`, `0x${string}`];

  console.log("authPath:       ", authPath);
  console.log("terms:          ", terms, `(${(terms.length - 2) / 2} bytes)`);

  // Must be exact: native here is WETH, so an approximate fee would be paid out of swap dust.
  const wormhole = (await publicClient.readContract({
    address: cfg.address,
    abi,
    functionName: "wormhole",
  })) as `0x${string}`;
  const fee = (await publicClient.readContract({
    address: wormhole,
    abi: wormholeAbi,
    functionName: "messageFee",
  })) as bigint;
  console.log("messageFee:     ", fee.toString());

  const hash = await walletClient.writeContract({
    address: cfg.address,
    abi,
    functionName: "publishQuote",
    args: [cfg.order],
    value: fee,
  });
  console.log("publishQuote tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, "block:", receipt.blockNumber);

  const published = parseEventLogs({ abi, eventName: "OrderPublished", logs: receipt.logs })[0];
  if (!published) throw new Error("publishQuote succeeded but no OrderPublished event.");
  const ev = published.args as { authPath: string; messageSequence: bigint };
  if (ev.authPath !== authPath) {
    throw new Error(`authPath mismatch: computed ${authPath}, emitted ${ev.authPath}`);
  }
  console.log(`OrderPublished authPath=${ev.authPath} messageSequence=${ev.messageSequence}`);
  console.log(`derive the NEAR account from path ${authPath}, then its deposit address`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
