/**
 * PROBE: full deploy + order placement of IntentEmitter on a chopsticks Hydration fork, driven by
 * real viem-signed eth transactions submitted as `pallet_ethereum::transact` (the
 * eth_sendRawTransaction path). Mirrors how hardhat/foundry deploy via the EVM RPC. Throwaway.
 *
 * v2 settles over NTT straight from Hydration — no XCM, no Moonbeam hop, no GLMR fee leg — so this
 * only needs the one fork. Two Wormhole messages should come out of `placeOrder`: the transceiver's
 * settlement and the emitter's own forwarding instruction.
 *
 * Uses the REAL prod Wormhole core + WETH NttManager so the measured gas reflects reality.
 *
 *   spawn → fund deployer → deploy impl + proxy (CREATE) → setNttManager/setIntentReceiver
 *         → approve + placeOrder
 *
 *   npx tsx contracts/scripts/intent-emitter/_probeDeployEmitter.ts
 */
import {
  encodeDeployData,
  encodeEventTopics,
  encodeFunctionData,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { h160, erc20 } from "@galacticcouncil/common";

import { configs } from "@whm/chopsticks/configs";
import { EthClient, type EthTxResult } from "@whm/chopsticks/eth";
import {
  checkIfEthereumExecuted,
  checkIfEvmLog,
  logEvents,
} from "@whm/chopsticks/events";
import { spawnForks, teardownForks, type Network } from "@whm/chopsticks/network";
import { getEventsAt, getTokenBalance } from "@whm/chopsticks/queries";

import intentEmitterJson from "../../out/IntentEmitter.sol/IntentEmitter.json";
import erc1967ProxyJson from "../../out/ERC1967Proxy.sol/ERC1967Proxy.json";

const { H160 } = h160;
const { ERC20 } = erc20;

// --- Abis --------------------------------------------------------

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

// ─── Constants ───────────────────────────────────────────────────

const CHAIN_ID = 222222;

const DOT = 5;
const WETH = 20;

const AMOUNT_IN = 100n * 10n ** 10n; // 100 DOT (10 dec)
const MIN_ETH_OUT = 1n;
const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000dead" as const;
const MAX_RELAY_FEE = 0n; // probe: no dest relay fee

// Real prod addresses so the NTT leg encodes against the actual config.
const WORMHOLE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as const; // Hydration core bridge
const NTT_MANAGER = "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7" as const; // Hydration WETH NttManager
// Not deployed for v2 yet — the emitter only stores it, so any address exercises the same path.
const INTENT_RECEIVER = "0x000000000000000000000000000000000000beef" as const;

const FUND = { hdx: 1_000n * 10n ** 12n, dot: 1_000n * 10n ** 10n, weth: 100n * 10n ** 18n };

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944babceb0f7d40bef0b46e16b3c5f1b3c";
const account = privateKeyToAccount(PK);

const emitterAbi = intentEmitterJson.abi as Abi;
const emitterBytecode = (intentEmitterJson as { bytecode: { object: Hex } }).bytecode.object;
const proxyAbi = erc1967ProxyJson.abi as Abi;
const proxyBytecode = (erc1967ProxyJson as { bytecode: { object: Hex } }).bytecode.object;

const ORDER_PLACED = encodeEventTopics({ abi: emitterAbi, eventName: "OrderPlaced" })[0]!;

// ─── Helpers ─────────────────────────────────────────────────────

async function check(net: Network, res: EthTxResult, label: string) {
  const events = await getEventsAt(net, res.blockHash);
  const ok = checkIfEthereumExecuted(events);
  console.log(`   ${ok ? "✅" : "❌"} ${label} @#${res.blockNumber}`);
  if (!ok) {
    logEvents(events);
  }
}

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;

  try {
    const deployer = account.address;
    const deployerAcct = H160.toAccount(deployer);
    console.log("\n🥢 Deployer:", deployer);

    await hydration.setStorage({
      System: {
        Account: [[[deployerAcct], { providers: 1, sufficients: 1, data: { free: FUND.hdx } }]],
      },
      Tokens: {
        Accounts: [
          [[deployerAcct, WETH], { free: FUND.weth }],
          [[deployerAcct, DOT], { free: FUND.dot }],
        ],
      },
    });

    const client = new EthClient(hydration, account, { chainId: CHAIN_ID, gas: 15_000_000n });

    // ── deploy impl + proxy ────────────────────────────────────────
    console.log("\n🥢 IntentEmitter deploy");

    const { address: implAddr, res: implRes } = await client.deploy(emitterBytecode);
    await check(hydration, implRes, `deploy ${implAddr}`);

    const initData = encodeFunctionData({
      abi: emitterAbi,
      functionName: "initialize",
      args: [WORMHOLE_CORE],
    });
    const proxyInitCode = encodeDeployData({
      abi: proxyAbi,
      bytecode: proxyBytecode,
      args: [implAddr, initData],
    });
    const { address: proxyAddr, res: proxyRes } = await client.deploy(proxyInitCode);
    await check(hydration, proxyRes, `deploy ${proxyAddr}`);

    // ── configure proxy ────────────────────────────────────────────
    console.log("\n🥢 IntentEmitter setup");

    // Reverts unless the manager's token is Hydration WETH, so this also asserts the address.
    const setNttManager = await client.call(
      proxyAddr,
      encodeFunctionData({ abi: emitterAbi, functionName: "setNttManager", args: [NTT_MANAGER] }),
    );
    await check(hydration, setNttManager, "setNttManager");

    const setIntentReceiver = await client.call(
      proxyAddr,
      encodeFunctionData({
        abi: emitterAbi,
        functionName: "setIntentReceiver",
        args: [INTENT_RECEIVER],
      }),
    );
    await check(hydration, setIntentReceiver, "setIntentReceiver");

    // ── approve + placeOrder ───────────────────────────────────────
    console.log("\n🥢 IntentEmitter execution");

    const approve = await client.call(
      ERC20.fromAssetId(DOT) as Hex,
      encodeFunctionData({
        abi: ERC20_APPROVE_ABI as unknown as Abi,
        functionName: "approve",
        args: [proxyAddr, AMOUNT_IN],
      }),
    );
    await check(hydration, approve, "approve DOT");

    // Not payable: the delivery price and message fee come out of the swap output, which works
    // because Hydration's native currency IS WETH.
    const placeOrder = await client.call(
      proxyAddr,
      encodeFunctionData({
        abi: emitterAbi,
        functionName: "placeOrder",
        args: [DOT, AMOUNT_IN, MIN_ETH_OUT, DEPOSIT_ADDRESS, MAX_RELAY_FEE],
      }),
    );
    await check(hydration, placeOrder, "placeOrder");

    const placeEvents = await getEventsAt(hydration, placeOrder.blockHash);
    const isOrderPlaced = checkIfEvmLog(placeEvents, ORDER_PLACED);

    console.log(`   ${isOrderPlaced ? "✅" : "❌"} OrderPlaced emitted`);

    // ── Did the swap move value? (race-free state reads at the swap block) ──
    const contractAcct = H160.toAccount(proxyAddr);
    const contractWeth = await getTokenBalance(hydration, contractAcct, WETH, placeOrder.blockHash);
    const deployerDot = await getTokenBalance(hydration, deployerAcct, DOT, placeOrder.blockHash);
    const deployerWeth = await getTokenBalance(hydration, deployerAcct, WETH, placeOrder.blockHash);

    console.log(`\n🥢 Post-swap:`);
    console.log(`   contract WETH ${contractWeth} (quantization dust + unspent fees)`);
    console.log(`   deployer DOT  ${deployerDot} (was ${FUND.dot})`);
    console.log(`   deployer WETH ${deployerWeth} (was ${FUND.weth})`);

    if (!isOrderPlaced) {
      logEvents(placeEvents);
    }
  } finally {
    await teardownForks(nets);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.message ?? e);
    process.exit(1);
  });
