import "dotenv/config";

import { isAddress, parseEventLogs, formatEther } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "@whm/common/evm";

import intentEmitterJson from "../../out/IntentEmitter.sol/IntentEmitter.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

// Hydration asset id → ERC20-precompile address: 0x0100000000 | assetId (HydrationConsts.toErc20).
function assetErc20(assetId: number): `0x${string}` {
  const v = (1n << 32n) + BigInt(assetId);
  return ("0x" + v.toString(16).padStart(40, "0")) as `0x${string}`;
}

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address"); // IntentEmitter proxy
  const assetIn = Number(requiredArg("--assetIn")); // Hydration asset id (e.g. DOT=5)
  const amountIn = BigInt(requiredArg("--amountIn")); // A pulled from the caller
  const minEthOut = BigInt(requiredArg("--minEthOut")); // floor on what ARRIVES, not on the swap
  const depositAddress = requiredArg("--depositAddress"); // Ethereum recipient
  const maxRelayFee = BigInt(optionalArg("--maxRelayFee") ?? "0");

  if (!isAddress(address)) throw new Error("Invalid --address (IntentEmitter).");
  if (!isAddress(depositAddress)) throw new Error("Invalid --depositAddress.");
  if (!Number.isInteger(assetIn) || assetIn < 0) throw new Error("Invalid --assetIn (asset id).");
  if (amountIn === 0n) throw new Error("--amountIn must be > 0.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    assetIn,
    amountIn,
    minEthOut,
    depositAddress: depositAddress as `0x${string}`,
    maxRelayFee,
  };
}

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

async function main(): Promise<void> {
  const cfg = getConfig();
  const { publicClient, walletClient, account } = getWallet(cfg.rpcUrl, cfg.chainId, cfg.privateKey);
  const { abi } = intentEmitterJson as ifs.ContractArtifact;

  const assetToken = assetErc20(cfg.assetIn);

  console.log("IntentEmitter:", cfg.address);
  console.log("caller:       ", account.address);
  console.log("assetIn:      ", cfg.assetIn, "->", assetToken);
  console.log("amountIn:     ", cfg.amountIn.toString());
  console.log("minEthOut:    ", cfg.minEthOut.toString());
  console.log("depositAddr:  ", cfg.depositAddress);
  console.log("maxRelayFee:  ", cfg.maxRelayFee.toString());

  // Not payable: the rail's delivery price and the message fee come out of the swap output, which
  // works because Hydration's native currency IS WETH — the ERC20 the swap produces is the same
  // balance the emitter spends as msg.value.
  const [nttManager, intentReceiver] = (await Promise.all([
    publicClient.readContract({ address: cfg.address, abi, functionName: "nttManager" }),
    publicClient.readContract({ address: cfg.address, abi, functionName: "intentReceiver" }),
  ])) as [`0x${string}`, `0x${string}`];
  console.log("nttManager:   ", nttManager);
  console.log("intentRcvr:   ", intentReceiver);
  if (BigInt(nttManager) === 0n || BigInt(intentReceiver) === 0n) {
    throw new Error("NotConfigured — set nttManager and intentReceiver first.");
  }

  const bal = (await publicClient.readContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  console.log("assetIn bal:  ", bal.toString());
  if (bal < cfg.amountIn) throw new Error(`Insufficient assetIn: have ${bal}, need ${cfg.amountIn}`);

  const approveHash = await walletClient.writeContract({
    address: assetToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [cfg.address, cfg.amountIn],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log("approved:", approveHash);

  const hash = await walletClient.writeContract({
    address: cfg.address,
    abi,
    functionName: "placeOrder",
    args: [
      cfg.assetIn,
      cfg.amountIn,
      cfg.minEthOut,
      cfg.depositAddress,
      cfg.maxRelayFee,
    ],
  });
  console.log("placeOrder tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status, "block:", receipt.blockNumber);

  const placed = parseEventLogs({ abi, eventName: "OrderPlaced", logs: receipt.logs })[0];
  if (!placed) throw new Error("placeOrder succeeded but no OrderPlaced event — investigate.");
  const { transferSequence, ethOut } = placed.args as {
    transferSequence: bigint;
    ethOut: bigint;
  };
  console.log(
    `OrderPlaced transferSequence=${transferSequence} ethOut=${ethOut} (${formatEther(ethOut)} ETH)`,
  );
  // The NTT manager's sequence, not a Wormhole one — it is what the receiver matches the settlement
  // and its forwarding instruction on.
  console.log(`match the settlement on manager sequence ${transferSequence}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
