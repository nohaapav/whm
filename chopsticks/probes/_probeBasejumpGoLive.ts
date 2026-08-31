/**
 * PROBE (Basejump go-live proposal): runs the Root call sequence that arms the Ethereum → Hydration
 * USDC corridor against a fork of live Hydration, one leg per block, reporting each leg's own
 * outcome — then drives a real fast-path VAA through the corridor it arms.
 *
 * Everything here is the REAL DEPLOYED STATE — the landing holding its EURC pool, the receiver
 * already wired to the Ethereum emitter and owned by the emergency admin, and the message core at
 * 0x3792a6…82a1. Nothing is deployed and nothing is mocked. Each leg runs through the real
 * `pallet_dispatcher` with a Root origin injected into `Scheduler.Agenda`, which is the same
 * dispatch a referendum performs on enactment.
 *
 * The float is recycled, not bought: the Base EURC corridor never went live on the v2 rails, so the
 * pool's 10,019 EURC is idle capital. It is withdrawn, sold for USDC, and seeded back.
 *
 * It also PRINTS the calldata — every leg, the `utility.batchAll` wrapping them, and the preimage
 * hash to reference it by — built against the fork's own metadata, since
 * @galacticcouncil/descriptors is stale against runtime 440. One definition of the eight legs
 * serves both, so what is enacted here cannot drift from what is submitted.
 *
 * TWO MODES. By default it enacts the legs one per block, so a failure names its own leg instead
 * of rolling the whole batch back anonymously. `--batch` enacts the `batch_all` that governance
 * actually submits — the only way to show eight dispatches, five of them EVM calls off one nonce,
 * fit in a single block's weight. Run both before submitting.
 *
 * WHAT THIS IS ACTUALLY TESTING. Three things state-reading cannot answer:
 *   1. Whether `dispatch_as_emergency_admin` → `EVM.call` works from `0xAA7e…AA7E1`, which has
 *      nonce 0 and zero balance on mainnet — it has never made an EVM call — while Hydration EVM
 *      gas is WETH-denominated. ANSWERED: it does not. Run without leg 0 and with
 *      `max_fee_per_gas = 0`, every EVM leg returns `dispatcher=Err` and emits no `Ethereum.*`
 *      event at all — rejected before execution. Hence leg 0 funds the admin and legs use a real
 *      `MAX_FEE_PER_GAS`.
 *   2. Where `landing.withdraw` actually credits. It is `IERC20.safeTransfer` over the asset-44
 *      precompile, so the destination H160 is resolved by `pallet-evm-accounts`: bound → the real
 *      AccountId, unbound → `b"ETH\0" ++ h160 ++ [0u8;8]`. The treasury cannot have bound itself,
 *      so this checks both candidate accounts and says which one the EURC lands in.
 *   3. That `dispatch_as_*` reports inner failure in an EVENT, not the extrinsic result. Each leg
 *      is verified by re-reading the landing, never by the dispatch's own outcome.
 *
 * Guardian signatures cannot be forged, so the core's guardian SET is swapped for a single key we
 * hold via `dev_setStorage` into `EVM.AccountStorages` — same substitution as
 * `_probeBasejumpDelivery`. The verification path itself is untouched.
 *
 *   npx tsx chopsticks/probes/_probeBasejumpGoLive.ts            # calldata, then leg by leg
 *   npx tsx chopsticks/probes/_probeBasejumpGoLive.ts --batch    # …as the one atomic call
 */
import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { logEvents, type EventRecord } from "../lib/events";
import { toJson } from "../lib/utils";

// ─── Live deployment ─────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const ETHEREUM_WORMHOLE_ID = 2;

const MESSAGE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as Hex;
const GUARDIAN_SET_INDEX = 7;

/** deployments/prod/basejump-ethereum.json — 005-deploy-receiver. */
const RECEIVER = "0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a" as Hex;
/** deployments/prod/basejump-ethereum.json — 001-deploy-emitter (on Ethereum). */
const ETH_EMITTER = "0xa72e2bf29c840eb93adbb9ee1aa41580f01c9944" as Hex;
const LANDING = "0x70e9b12c3b19cb5f0e59984a5866278ab69df976" as Hex;
/** The dead Moonbeam-era bridge, still authorized on the pool today. */
const MRL_BRIDGE = "0x10c06f418a082e636ee932ce8f9c5e791b925b51" as Hex;

const EURC_BASE = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as Hex;
const EURC_HYDRATION = "0x000000000000000000000000000000010000002c" as Hex;
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const USDC_HYDRATION = "0x0000000000000000000000000000000100000015" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

const EURC_ASSET_ID = 44;
const AEURC_ASSET_ID = 1044;
const HOLLAR_ASSET_ID = 222;
/** Stableswap pool ids backing the route below: [222,1044] and [21,23,222]. */
const AEURC_HOLLAR_POOL = 10044;
const HOLLAR_USDC_POOL = 105;
const USDC_ASSET_ID = 21;
const WETH_ASSET_ID = 20;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
const EMERGENCY_ADMIN_ACCOUNT =
  "0xaa7e0000000000000000000000000000000aa7e1000000000000000000000000" as Hex;
/**
 * Where leg 0's gas MUST go. `0xAA7e…AA7E1` is unbound in `pallet-evm-accounts`, so `pallet_evm`
 * charges `b"ETH\0" ++ h160 ++ [0u8;8]` — NOT the native `EMERGENCY_ADMIN_ACCOUNT`. Measured:
 * funding the native form leaves `eth_getBalance` at 0 and every EVM leg fails `EVM.BalanceLow`.
 */
const EMERGENCY_ADMIN_EVM_ACCOUNT =
  "0x45544800aa7e0000000000000000000000000000000aa7e10000000000000000" as Hex;

/** b"modlpy/trsry" ++ [0u8;20] — the real treasury AccountId32. */
const TREASURY_ACCOUNT = `0x6d6f646c70792f7472737279${"00".repeat(20)}` as Hex;
/** Its first 20 bytes — what `pallet-evm-accounts` truncates the treasury to, and the only
 *  plausible `to` for an ERC20 `withdraw`. */
const TREASURY_H160 = "0x6d6f646c70792f74727372790000000000000000" as Hex;

// ─── Proposal parameters ─────────────────────────────────────────

/** The pool's entire EURC balance, read live. */
const EURC_DRAIN = 10_019_067_655n;
/** Router.sell minimum — 2% under the 11,598.585581 USDC the 3-hop route returned on a fork. */
const SWAP_MIN_USDC = 11_366_000_000n;
/** Seeded back into the pool; the remainder stays in the treasury. */
const POOL_SEED = 10_000_000_000n; // 10,000 USDC

/**
 * EURC → USDC, explicit. Neither asset is in the Omnipool, so an EMPTY route defaults there and
 * fails `Omnipool.AssetNotFound` — measured. The live 3-hop path wraps EURC into its aToken, then
 * crosses two stableswaps via HOLLAR.
 */
const EURC_TO_USDC_ROUTE = [
  { pool: { Aave: null }, asset_in: EURC_ASSET_ID, asset_out: AEURC_ASSET_ID },
  { pool: { Stableswap: AEURC_HOLLAR_POOL }, asset_in: AEURC_ASSET_ID, asset_out: HOLLAR_ASSET_ID },
  { pool: { Stableswap: HOLLAR_USDC_POOL }, asset_in: HOLLAR_ASSET_ID, asset_out: USDC_ASSET_ID },
];

const GAS_LIMIT = 300_000n;
/** MUST exceed the base fee (~5.9e6, read live 2026-08-31) — 0 is rejected as GasPriceTooLow. */
const MAX_FEE_PER_GAS = 10_000_000_000n; // 10 gwei
/** Leg 0: treasury → emergency admin. It has nonce 0 and 0 WETH; EVM gas here is WETH-denominated. */
const GAS_WETH = 10_000_000_000_000_000n; // 0.01 WETH

// ─── Canary transfer ─────────────────────────────────────────────

const GROSS = 100_000_000n; // 100 USDC
const FEE = 100_000n; //   0.1 USDC — emitter.assetFee[USDC], read live
const NET = GROSS - FEE;

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const GUARDIAN_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
/** Alice. */
const RECIPIENT = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;

const HYDRATION_SS58_PREFIX = 63;

/** The canary is scaffolding (it forges a guardian set); the proposal is the eight calls. */
const RUN_CANARY = process.argv.includes("--canary");
/** Enact the batchAll governance submits, rather than the eight legs one per block. */
const RUN_BATCH = process.argv.includes("--batch");

const LANDING_ABI = parseAbi([
  "function authorizedBridges(address) view returns (bool)",
  "function destAssetFor(address) view returns (address)",
  "function setAuthorizedBridge(address,bool)",
  "function setDestAsset(address,address)",
  "function withdraw(address,uint256,address)",
]);
const RECEIVER_ABI = parseAbi(["function completeTransfer(bytes)"]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ─── Helpers ─────────────────────────────────────────────────────

/** One call of the proposal: its calldata is what governance submits, its `call` what we enact. */
type Leg = { label: string; call: any; evmInput?: Hex };

/**
 * A `BoundedVec<u8>` storage value — `compact(len) ++ bytes` — from a call's hex.
 *
 * `dev_setStorage` writes a `0x` string VERBATIM (chopsticks-core `utils/set-storage.js`), so the
 * length prefix is the caller's to add. Writing a bare call hex stores a preimage that decodes to
 * LENGTH ZERO, and the scheduler drops the entry as `CallUnavailable` with nothing else to show.
 */
function boundedBytes(hex: string): string {
  const n = (hex.length - 2) / 2;
  const byte = (v: number) => (v & 0xff).toString(16).padStart(2, "0");
  let prefix: string;
  if (n < 1 << 6) prefix = byte(n << 2);
  else if (n < 1 << 14) prefix = byte((n << 2) | 0b01) + byte((n << 2) >> 8);
  else if (n < 1 << 30) prefix = [0, 8, 16, 24].map((s) => byte(((n << 2) | 0b10) >>> s)).join("");
  else throw new Error(`boundedBytes: ${n} exceeds the 4-byte compact mode`);
  return `0x${prefix}${hex.slice(2)}`;
}


/** Hydration's unbound-H160 → AccountId32 mapping: b"ETH\0" ++ h160 ++ [0u8;8]. */
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);

const slotHex = (n: bigint): Hex => pad(numberToHex(n), { size: 32 });

const amt = (v: bigint, sym: string): string => `${(Number(v) / 1e6).toFixed(6)} ${sym}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry a read through chopsticks' post-block lag. */
async function retry<T>(what: string, fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last).slice(0, 160)}`);
}

/** See _probeBasejumpDelivery for the storage-layout derivation of the core's guardian set. */
function guardianSetOverride(guardian: Hex): Record<string, unknown> {
  const base = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [BigInt(GUARDIAN_SET_INDEX), 2n],
      ),
    ),
  );
  const keysData = BigInt(keccak256(slotHex(base)));
  return {
    EVM: {
      AccountStorages: [
        [[MESSAGE_CORE, slotHex(base)], slotHex(1n)],
        [[MESSAGE_CORE, slotHex(keysData)], pad(guardian, { size: 32 })],
      ],
    },
  };
}

async function buildSignedVaa(opts: {
  emitterChain: number;
  emitter: Hex;
  sequence: bigint;
  payload: Hex;
}): Promise<Hex> {
  const body = concatHex([
    pad(numberToHex(Math.floor(Date.now() / 1000)), { size: 4 }),
    pad(numberToHex(0), { size: 4 }),
    pad(numberToHex(opts.emitterChain), { size: 2 }),
    pad(opts.emitter, { size: 32 }),
    pad(numberToHex(opts.sequence), { size: 8 }),
    pad(numberToHex(200), { size: 1 }),
    opts.payload,
  ]);
  const { r, s, v } = await sign({ hash: keccak256(keccak256(body)), privateKey: GUARDIAN_PK });
  return concatHex([
    pad(numberToHex(1), { size: 1 }),
    pad(numberToHex(GUARDIAN_SET_INDEX), { size: 4 }),
    pad(numberToHex(1), { size: 1 }),
    pad(numberToHex(0), { size: 1 }),
    pad(r, { size: 32 }),
    pad(s, { size: 32 }),
    pad(numberToHex(Number(v! - 27n)), { size: 1 }),
    body,
  ]);
}

/** abi.encode(IBasejumpPayload.TransferPayload). */
const transferPayload = (amount: bigint, seq: bigint): Hex =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceAsset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "bytes32" },
          { name: "transferSequence", type: "uint64" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [{ sourceAsset: USDC_ETHEREUM, amount, recipient: RECIPIENT, transferSequence: seq, data: "0x" }],
  );

async function eventsAt(net: Network, at: string, tries = 12): Promise<EventRecord[]> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return (await net.client.getUnsafeApi().query.System.Events.getValue({ at })) as EventRecord[];
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

const evName = ({ event }: EventRecord): string => {
  const e = event as { type: string; value: { type: string } };
  return `${e.type}.${e.value?.type}`;
};

/**
 * TWO pallets emit an `Executed`, and the legs and the canary do not use the same one.
 * `EVM.call` — every dispatcher leg — is pallet_evm, which reports success by VARIANT
 * (`Executed` vs `ExecutedFailed`). `Ethereum.transact` — the canary, via sendRawEthTx — is
 * pallet_ethereum, which always emits `Executed` and carries the outcome in `exit_reason`.
 * Matching only the latter reads every dispatcher leg as a failure.
 */
function evmSucceeded(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    const ev = event as { type: string; value: { type: string; value?: { exit_reason?: unknown } } };
    if (ev.type === "EVM") return ev.value?.type === "Executed";
    if (ev.type !== "Ethereum" || ev.value?.type !== "Executed") return false;
    return (ev.value.value?.exit_reason as { type?: string } | undefined)?.type === "Succeed";
  });
}

/** Successful pallet_evm calls in a block — one per dispatcher leg that actually ran. */
const evmExecutedCount = (events: EventRecord[]): number =>
  events.filter((e) => evName(e) === "EVM.Executed").length;

/**
 * The inner result carried by dispatcher's *CallDispatched events — outer success hides this.
 *
 * Discriminated by PAYLOAD, not by a variant tag: the Err arm is `DispatchErrorWithPostInfo`
 * (`{post_info, error}`), the Ok arm a bare `PostDispatchInfo` (`{pays_fee, ..}`). Reading a
 * `.type === "Ok"` tag mislabels a leg that plainly succeeded.
 */
function dispatchInnerResult(events: EventRecord[]): { ok: boolean; err: string | null } | null {
  for (const { event } of events) {
    const e = event as {
      type: string;
      value: { type: string; value?: { result?: { value?: { error?: unknown } } } };
    };
    if (e.type === "Dispatcher" && e.value?.type?.endsWith("CallDispatched")) {
      const err = e.value.value?.result?.value?.error;
      return err === undefined ? { ok: true, err: null } : { ok: false, err: toJson(err) };
    }
  }
  return null;
}

/** Raw bytes of a papi storage value — `Vec<u8>` comes back as a Uint8Array, not always a Binary. */
function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  const b = (v as { asBytes?: () => Uint8Array } | undefined)?.asBytes?.();
  return b instanceof Uint8Array ? b : undefined;
}

/** Did the scheduler actually run the looked-up call? CallUnavailable == a silently dropped leg. */
function schedulerDispatched(events: EventRecord[]): boolean {
  return events.some((e) => evName(e) === "Scheduler.Dispatched");
}

const results: { leg: string; ok: boolean }[] = [];
const record = (leg: string, ok: boolean, detail = ""): boolean => {
  results.push({ leg, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${leg}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;

  try {
    const rpc = hydration.url.replace("ws://", "http://").replace("[::]", "127.0.0.1");
    const pub = createPublicClient({ transport: http(rpc) });
    const api = hydration.client.getUnsafeApi();
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> }).registry) as any;

    const landingAcct = truncatedEvmAccount(LANDING);
    const landingSub = ss58(landingAcct);
    const recipientSub = ss58(RECIPIENT);
    const treasurySub = ss58(TREASURY_ACCOUNT);
    const treasuryTruncSub = ss58(truncatedEvmAccount(TREASURY_H160));

    const tokenBalance = async (account: string, assetId: number, at?: string): Promise<bigint> => {
      const v = (await retry(`Tokens.Accounts(${assetId})`, () =>
        api.query.Tokens.Accounts.getValue(account, assetId, at ? { at } : {}),
      )) as { free?: bigint } | undefined;
      return v?.free ?? 0n;
    };
    const readBridge = (b: Hex) =>
      retry("authorizedBridges", () =>
        pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: "authorizedBridges", args: [b] }),
      );
    const readDest = (src: Hex) =>
      retry("destAssetFor", () =>
        pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: "destAssetFor", args: [src] }),
      );
    const readErc20 = (token: Hex, who: Hex) =>
      retry("balanceOf", () =>
        pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }),
      );

    console.log(`\n🥢 Basejump go-live probe — real deployment, real dispatcher path`);
    console.log(`   landing   ${LANDING}`);
    console.log(`   receiver  ${RECEIVER}`);
    console.log(`   admin     ${EMERGENCY_ADMIN}  (funded by leg 0)`);

    // ── pre-state ──
    console.log(`\n── Before ──`);
    console.log(`   receiver authorized  ${await readBridge(RECEIVER)}`);
    console.log(`   EURC route           ${await readDest(EURC_BASE)}`);
    console.log(`   USDC route           ${await readDest(USDC_ETHEREUM)}`);
    console.log(`   pool EURC            ${amt(await readErc20(EURC_HYDRATION, LANDING), "EURC")}`);
    console.log(`   pool USDC            ${amt(await readErc20(USDC_HYDRATION, LANDING), "USDC")}`);
    console.log(`   admin WETH           ${await tokenBalance(ss58(EMERGENCY_ADMIN_ACCOUNT), WETH_ASSET_ID)}`);
    console.log(`   treasury EURC        ${amt(await tokenBalance(treasurySub, EURC_ASSET_ID), "EURC")}`);

    // ── one Root call per block, so a failure names its own leg ──
    //
    // Scheduled through a PREIMAGE, not Inline. `BoundedInline` caps at 128 bytes and a
    // dispatchAsEmergencyAdmin(evm.call(..)) encodes to ~190 — an inline agenda entry for one is
    // dropped silently, with no Scheduler.Dispatched at all. A referendum enacts via preimage too,
    // so this is also the more faithful path.
    const enact = async ({ label, call }: Leg): Promise<{ hash: string; events: EventRecord[] }> => {
      const head = (await retry("head", () => api.query.System.Number.getValue())) as number;
      const bytes = call.toU8a();
      const callHash = registry.hash(bytes).toHex();
      const len = bytes.length;
      // `QueryPreimage::fetch` goes straight to PreimageFor when the length is known, so no
      // RequestStatusFor entry is needed — and a malformed one silently voids the whole write.
      //
      // The value is `BoundedVec<u8>` = compact(len) ++ bytes, and chopsticks writes a 0x-string
      // VERBATIM (see chopsticks-core utils/set-storage.js) — so the prefix is ours to add. Passing
      // the bare `call.toHex()` here stores a preimage that decodes to LENGTH ZERO, and every leg
      // dies as Scheduler.CallUnavailable.
      await hydration.setStorage({
        Preimage: { PreimageFor: [[[[callHash, len]], boundedBytes(call.toHex())]] },
      });
      // Assert the LENGTH, not mere presence: an empty/truncated value reads back truthy.
      // papi hands this back as a bare Uint8Array, not a Binary — accept either shape.
      const stored = await retry("PreimageFor", () =>
        api.query.Preimage.PreimageFor.getValue([callHash, len]),
      );
      const storedLen = asBytes(stored)?.length ?? -1;
      if (storedLen !== len) {
        throw new Error(`preimage for "${label}" stored ${storedLen} bytes, want ${len} (${callHash})`);
      }
      await hydration.setStorage({
        Scheduler: {
          Agenda: [
            [
              [head + 1],
              [{ call: { Lookup: { hash: callHash, len } }, origin: { system: "Root" }, maybeId: null, priority: 0, maybePeriodic: null }],
            ],
          ],
        },
      });
      // Build IN-PROCESS, not through the dev_newBlock RPC. On a heavy block — the batchAll runs
      // eight dispatches, five of them EVM calls — the RPC request never returns and chopsticks
      // keeps rebuilding (the README's dev_newBlock gotcha, and why sendRawEthTx builds in-process
      // too). chain.newBlock() builds exactly one block and hands it straight back.
      const { hash } = await (hydration.chain as unknown as {
        newBlock: () => Promise<{ hash: string }>;
      }).newBlock();
      const evs = await eventsAt(hydration, hash);
      const res = dispatchInnerResult(evs);
      const inner = res === null ? null : res.ok;
      const err = res?.err ?? null;
      const evm = evs.some((e) => evName(e).startsWith("Ethereum.") || evName(e).startsWith("EVM."));
      console.log(
        `   · ${label}: dispatcher=${inner === null ? "n/a" : inner ? "Ok" : "Err"}` +
          (err ? ` ${err}` : "") +
          (evm ? ` evm=${evmSucceeded(evs) ? "Succeed" : "FAILED"}` : "") +
          `  [${[...new Set(evs.map(evName))].filter((n) => !n.startsWith("System.Extrinsic") && !n.startsWith("RelayChainInfo")).join(" ")}]`,
      );
      // A leg that never dispatched is a broken harness, not a failed proposal — stop rather than
      // let downstream assertions blame the sequence for it.
      if (!schedulerDispatched(evs)) {
        throw new Error(`"${label}" never dispatched (${len} bytes) — the scheduler dropped it`);
      }
      return { hash, events: evs };
    };

    const enc = (fn: string, args: unknown[]) =>
      encodeFunctionData({ abi: LANDING_ABI, functionName: fn, args } as never);
    /** A landing leg: the emergency admin calling the landing through pallet_dispatcher. */
    const adminLeg = (label: string, evmInput: Hex): Leg => ({
      label,
      evmInput,
      call: meta.tx.dispatcher.dispatchAsEmergencyAdmin(
        meta.tx.evm.call(EMERGENCY_ADMIN, LANDING, evmInput, 0, GAS_LIMIT, MAX_FEE_PER_GAS, null, null, [], []),
      ),
    });
    const treasuryLeg = (label: string, inner: any): Leg => ({
      label,
      call: meta.tx.dispatcher.dispatchAsTreasury(inner),
    });

    // The proposal. Ordering is load-bearing: gas before the EVM legs, drain before the swap, seed
    // before arming, map before arming — an armed bridge over an empty or unmapped pool queues
    // silently instead of reverting.
    const legs: Leg[] = [
      // Measured, not assumed: with max_fee_per_gas = 0 and no funding, every EVM leg came back
      // `dispatcher=Err` with no Ethereum.* event at all.
      treasuryLeg(
        "0 fund gas — treasury → admin's ETH\\0 account, 0.01 WETH",
        meta.tx.currencies.transfer(EMERGENCY_ADMIN_EVM_ACCOUNT, WETH_ASSET_ID, GAS_WETH),
      ),
      adminLeg("1 landing.setDestAsset(EURC_base, 0) — unmap EURC", enc("setDestAsset", [EURC_BASE, ZERO])),
      adminLeg("2 landing.setAuthorizedBridge(MRL, false) — revoke", enc("setAuthorizedBridge", [MRL_BRIDGE, false])),
      adminLeg("3 landing.withdraw(EURC → treasury) — drain", enc("withdraw", [EURC_HYDRATION, EURC_DRAIN, TREASURY_H160])),
      treasuryLeg(
        "4 Router.sell(EURC → USDC, 3-hop explicit)",
        meta.tx.router.sell(EURC_ASSET_ID, USDC_ASSET_ID, EURC_DRAIN, SWAP_MIN_USDC, EURC_TO_USDC_ROUTE),
      ),
      treasuryLeg(
        "5 Currencies.transfer(pool, USDC) — seed",
        meta.tx.currencies.transfer(landingAcct, USDC_ASSET_ID, POOL_SEED),
      ),
      adminLeg("6 landing.setDestAsset(USDC_eth, asset 21) — map USDC", enc("setDestAsset", [USDC_ETHEREUM, USDC_HYDRATION])),
      adminLeg("7 landing.setAuthorizedBridge(receiver, true) — GO-LIVE", enc("setAuthorizedBridge", [RECEIVER, true])),
    ];

    // ── the calldata to submit ──
    //
    // Built against the FORK's own metadata, not @galacticcouncil/descriptors — those are stale
    // against runtime 440 (Currencies/EVM fail checksum there). Re-read these bytes immediately
    // before submitting: every one changes if an amount, the swap minimum or the gas price does.
    console.log(`\n── Calldata ──`);
    for (const { label, call, evmInput } of legs) {
      console.log(`\n   ${label}`);
      if (evmInput) console.log(`     evm input : ${evmInput}`);
      console.log(`     call      : ${call.toHex()}`);
    }
    const batch = meta.tx.utility.batchAll(legs.map((l) => l.call));
    const batchBytes = batch.toU8a();
    console.log(`\n   batchAll — what governance submits, as ONE atomic Root call`);
    console.log(`     len       : ${batchBytes.length} bytes`);
    console.log(`     preimage  : ${registry.hash(batchBytes).toHex()}`);
    console.log(`     call      : ${batch.toHex()}`);

    // Two ways to run the same eight calls. `--batch` enacts the ONE atomic call governance
    // actually submits; the default enacts them separately so a failure names its own leg.
    if (RUN_BATCH) {
      // Only the batch shows what leg-by-leg structurally cannot: eight dispatches in ONE block,
      // five EVM calls off the same admin nonce, the router swap and the seed with no block
      // boundary between them — all against one block's weight limit.
      console.log(`\n── Enacting the batchAll — one atomic Root call ──`);
      const { hash: batchHash, events: batchEvents } = await enact({
        label: `batchAll (${legs.length} legs, ${batchBytes.length} bytes)`,
        call: batch,
      });
      // Headroom, for information only — NOT a pass/fail. That the batch fits is already proven by
      // BatchCompleted in a sealed block: an agenda item too heavy for max_block is postponed by
      // the scheduler, not executed. Worth printing because a fork block carries only our own
      // extrinsic, where a real one shares the budget with everybody else's.
      const used = (await retry("System.BlockWeight", () =>
        api.query.System.BlockWeight.getValue({ at: batchHash }),
      ).catch(() => undefined)) as { normal?: { ref_time?: bigint; proof_size?: bigint } } | undefined;
      // The ceiling is a runtime CONSTANT, so read it from the fork's own metadata — the same
      // object every leg above is built from. papi's `api.constants` is the one metadata path this
      // probe doesn't use, @galacticcouncil/descriptors being stale against runtime 440.
      const big = (v: unknown): bigint | undefined =>
        typeof v === "bigint" ? v : (v as { toBigInt?: () => bigint } | undefined)?.toBigInt?.();
      const maxBlock = meta?.consts?.system?.blockWeights?.maxBlock;
      const max = { ref_time: big(maxBlock?.refTime), proof_size: big(maxBlock?.proofSize) };
      const pct = (u?: bigint, m?: bigint) =>
        u && m ? `${((Number(u) / Number(m)) * 100).toFixed(1)}% of max` : `${u ?? "?"} (max ${m ?? "?"})`;
      console.log(
        `   block weight — ref_time ${pct(used?.normal?.ref_time, max?.ref_time)},` +
          ` proof_size ${pct(used?.normal?.proof_size, max?.proof_size)}`,
      );

      const evmExecuted = evmExecutedCount(batchEvents);
      record("batch completed, not reverted", batchEvents.some((e) => evName(e) === "Utility.BatchCompleted"));
      record("all five EVM legs ran in the one block", evmExecuted === 5, `${evmExecuted}/5 EVM.Executed`);
      // The drain is invisible afterwards — leg 4 spends the EURC it produced — so check it here.
      record("pool drained of EURC", (await readErc20(EURC_HYDRATION, LANDING)) === 0n);
    } else {
      console.log(`\n── Enacting, one leg per block ──`);

      await enact(legs[0]);
      // WHICH account does pallet_evm actually debit for gas? An H160 resolves either to a bound
      // AccountId or to `b"ETH\0" ++ h160 ++ [0u8;8]`. Leg 0 credits the native form; if the EVM
      // reads the derived one instead, the proposal funds a dead account and every EVM leg fails
      // `EVM.BalanceLow`. eth_getBalance on the H160 is the decisive read — it goes through the
      // same mapping pallet_evm uses.
      const adminNative = await tokenBalance(ss58(EMERGENCY_ADMIN_ACCOUNT), WETH_ASSET_ID);
      const adminDerived = await tokenBalance(ss58(truncatedEvmAccount(EMERGENCY_ADMIN)), WETH_ASSET_ID);
      const adminEvm = await retry("eth balance", () => pub.getBalance({ address: EMERGENCY_ADMIN }));
      console.log(`   after leg 0 — which account holds the gas?`);
      console.log(`     native   (0xaa7e…aa7e1 ++ [0;12])   ${adminNative}`);
      console.log(`     ETH\\0-derived                       ${adminDerived}`);
      console.log(`     what the EVM sees (eth_getBalance)  ${adminEvm}`);
      // eth_getBalance reads 0 here even when gas works — chopsticks' eth RPC does not surface the
      // mapped account's WETH. The derived account's asset-20 balance is what pallet_evm spends.
      record("gas landed in the account pallet_evm debits", adminDerived === GAS_WETH, `${adminDerived}`);

      // 1. unmap EURC — the Base corridor never went live on v2 rails
      await enact(legs[1]);
      // 2. revoke the dead Moonbeam-era bridge
      await enact(legs[2]);
      // 3. drain the idle EURC to the treasury — ERC20 safeTransfer to an H160
      await enact(legs[3]);

      // where did it actually land?
      const inRealTreasury = await tokenBalance(treasurySub, EURC_ASSET_ID);
      const inTruncated = await tokenBalance(treasuryTruncSub, EURC_ASSET_ID);
      const poolAfterDrain = await readErc20(EURC_HYDRATION, LANDING);
      console.log(`\n   withdraw landed where?`);
      console.log(`     pool now       ${amt(poolAfterDrain, "EURC")}`);
      console.log(`     real treasury  (${treasurySub.slice(0, 12)}…)  ${amt(inRealTreasury, "EURC")}`);
      console.log(`     ETH\\0-derived  (${treasuryTruncSub.slice(0, 12)}…)  ${amt(inTruncated, "EURC")}`);
      // must have LEFT the pool and ARRIVED in the real treasury — an untouched pool means the leg
      // never ran, which the old form scored as a pass.
      record("withdraw drained the pool", poolAfterDrain === 0n, amt(poolAfterDrain, "EURC"));
      record(
        "withdraw credits the REAL treasury",
        inRealTreasury >= EURC_DRAIN && inTruncated === 0n,
        inTruncated > 0n ? `stranded in the ETH\\0-derived account` : "",
      );

      // 4. sell the recycled EURC for USDC, as the treasury
      await enact(legs[4]);
      const treasuryUsdc = await tokenBalance(treasurySub, USDC_ASSET_ID);
      record("swap produced USDC", treasuryUsdc >= SWAP_MIN_USDC, `treasury now ${amt(treasuryUsdc, "USDC")}`);

      // 5. seed the pool
      await enact(legs[5]);
      // 6. map the USDC route BEFORE arming
      await enact(legs[6]);
      // 7. the go-live switch
      await enact(legs[7]);
    }

    // ── verify by reading the landing, never by the dispatch outcome ──
    console.log(`\n── After ──`);
    record("EURC route unmapped", (await readDest(EURC_BASE)) === ZERO);
    record("MRL bridge revoked", (await readBridge(MRL_BRIDGE)) === false);
    record("USDC → asset 21 mapped", (await readDest(USDC_ETHEREUM)).toLowerCase() === USDC_HYDRATION.toLowerCase());
    record("receiver AUTHORIZED — corridor armed", (await readBridge(RECEIVER)) === true);
    const poolUsdc = await readErc20(USDC_HYDRATION, LANDING);
    record("pool seeded", poolUsdc === POOL_SEED, amt(poolUsdc, "USDC"));

    // ── canary: a real VAA from the real Ethereum emitter ──
    //
    // OFF by default. It fabricates a VAA by swapping the guardian set — test scaffolding, not
    // part of what governance enacts. The eight on-chain calls above are the proposal. Re-enable
    // with `--canary` once a basejump relayer exists to deliver the fast path for real.
    if (!RUN_CANARY) {
      const failedEarly = results.filter((r) => !r.ok);
      console.log(
        failedEarly.length === 0
          ? `\n🥢 ✅ PROPOSAL ENACTS — all ${results.length} checks pass. Corridor armed and funded.` +
            `\n   (canary skipped; pass --canary to drive a fabricated VAA through it)`
          : `\n🥢 ❌ ${failedEarly.length}/${results.length} failed: ${failedEarly.map((f) => f.leg).join(", ")}`,
      );
      if (failedEarly.length) process.exitCode = 1;
      return;
    }

    console.log(`\n── Canary through the armed corridor ──`);
    const account = privateKeyToAccount(DEPLOYER_PK);
    const guardian = privateKeyToAccount(GUARDIAN_PK);
    const relayerSub = ss58(truncatedEvmAccount(account.address));
    await hydration.setStorage({
      System: { Account: [[[relayerSub], { providers: 1, data: { free: 1_000_000n * 10n ** 12n } }]] },
      Tokens: { Accounts: [[[relayerSub, WETH_ASSET_ID], { free: 1_000n * 10n ** 18n }]] },
    });
    await hydration.setStorage(guardianSetOverride(guardian.address));
    console.log(`   guardian set ${GUARDIAN_SET_INDEX}: 19 keys → 1 (ours), quorum 1`);

    const poolBefore = await tokenBalance(landingSub, USDC_ASSET_ID);
    const recipBefore = await tokenBalance(recipientSub, USDC_ASSET_ID);

    const vaa = await buildSignedVaa({
      emitterChain: ETHEREUM_WORMHOLE_ID,
      emitter: ETH_EMITTER,
      sequence: 1n,
      payload: transferPayload(NET, 1n),
    });
    const client = new EthClient(hydration, account, { chainId: HYDRATION_EVM_CHAIN_ID });
    const res = await client.call(
      RECEIVER,
      encodeFunctionData({ abi: RECEIVER_ABI, functionName: "completeTransfer", args: [vaa] }),
    );
    const relayEvents = await eventsAt(hydration, res.blockHash);
    if (!record("completeTransfer executed", evmSucceeded(relayEvents))) {
      // Ethereum.Executed carries only `Revert` with no data — re-run it as eth_call to get the
      // reason string. Wormhole's parseAndVerifyVM reverts with a plain-text `reason`.
      try {
        await pub.call({
          account: account.address,
          to: RECEIVER,
          data: encodeFunctionData({ abi: RECEIVER_ABI, functionName: "completeTransfer", args: [vaa] }),
        });
        console.log(`   eth_call did NOT revert — the failure is submission-side, not the call`);
      } catch (e) {
        const m = e as { shortMessage?: string; details?: string; message?: string };
        console.log(`   revert reason: ${m.shortMessage ?? m.details ?? m.message}`);
      }
      logEvents(relayEvents);
    }

    const poolAfter = await tokenBalance(landingSub, USDC_ASSET_ID, res.blockHash);
    const recipAfter = await tokenBalance(recipientSub, USDC_ASSET_ID, res.blockHash);
    console.log(`   pool       ${amt(poolBefore, "USDC")} → ${amt(poolAfter, "USDC")}`);
    console.log(`   recipient  ${amt(recipBefore, "USDC")} → ${amt(recipAfter, "USDC")}`);
    record("recipient paid the net", recipAfter - recipBefore === NET, amt(NET, "USDC"));
    record("pool debited the same", poolBefore - poolAfter === NET);

    const failed = results.filter((r) => !r.ok);
    console.log(
      failed.length === 0
        ? `\n🥢 ✅ SEQUENCE ENACTS AND THE CORRIDOR PAYS — dispatcher → EVM.call → armed landing → asset 21 moved.`
        : `\n🥢 ❌ ${failed.length}/${results.length} failed: ${failed.map((f) => f.leg).join(", ")}`,
    );
    if (failed.length) process.exitCode = 1;
  } finally {
    await teardownForks(nets).catch(() => {});
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
