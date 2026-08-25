"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/fetch.ts
var nativeFetch = globalThis.fetch;
function restoreNativeFetch() {
  if (nativeFetch) globalThis.fetch = nativeFetch;
}

// src/logger.ts
var winston = __toESM(require("winston"));
var logger_default = winston.createLogger({
  transports: [new winston.transports.Console({ level: process.env.LOG_LEVEL || "info" })],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.splat(),
    winston.format.simple(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.errors({ stack: true })
  )
});

// src/features/hydration-ntt/index.ts
var import_viem4 = require("viem");
var import_accounts = require("viem/accounts");

// src/config/env.ts
var import_viem = require("viem");
function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}
function reqAddress(name) {
  const v = req(name);
  if (!(0, import_viem.isAddress)(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}
function reqPrivateKey(name) {
  const raw = req(name).trim();
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} is not a 32-byte hex private key (got ${hex.length} hex chars)`);
  }
  return `0x${hex.toLowerCase()}`;
}
function opt(name, fallback) {
  return process.env[name] || fallback;
}
function optNum(name, fallback) {
  const v = process.env[name];
  return v === void 0 || v === "" ? fallback : Number(v);
}
function engineConfig() {
  return {
    spyEndpoint: opt("SPY_ENDPOINT", "localhost:7073"),
    redis: {
      host: opt("REDIS_HOST", "localhost"),
      port: optNum("REDIS_PORT", 6379)
    }
  };
}

// src/config/hydration.ts
var HYDRATION_EVM_CHAIN_ID = 222222;
function hydrationConfig() {
  return {
    /**
     * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the
     * existing queue and missed-VAA cursors. See engine/app.ts.
     */
    name: opt("APP_NAME", "hydration-ntt-relayer"),
    privateKey: reqPrivateKey("PRIVKEY"),
    rpc: opt("HYDRATION_RPC", "https://hydration-rpc.n.dwellir.com"),
    /** Cold-start floors per origin chain; ignored once a safeSequence exists in Redis. */
    fromSequence: {
      ethereum: BigInt(opt("NTT_ETH_FROM_SEQ", "0")),
      base: BigInt(opt("NTT_BASE_FROM_SEQ", "0")),
      solana: BigInt(opt("NTT_SOLANA_FROM_SEQ", "0")),
      sui: BigInt(opt("NTT_SUI_FROM_SEQ", "0"))
    },
    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50")),
    retries: optNum("NTT_RETRIES", 8)
  };
}

// src/engine/app.ts
var import_relayer_engine = require("@wormhole-foundation/relayer-engine");
function makeApp(cfg, opts) {
  return new import_relayer_engine.StandardRelayerApp(import_relayer_engine.Environment.MAINNET, {
    name: opts.name,
    logger: logger_default,
    spyEndpoint: cfg.spyEndpoint,
    redis: cfg.redis,
    ...opts.retries ? { workflows: { retries: opts.retries } } : {},
    ...opts.backoff ? { retryBackoffOptions: { baseDelayMs: opts.backoff.baseMs, maxDelayMs: opts.backoff.maxMs } } : {},
    ...opts.startingSequence ? { missedVaaOptions: { startingSequenceConfig: opts.startingSequence } } : {}
  });
}

// src/engine/ntt.ts
var import_viem2 = require("viem");
var NTT_TRANSFER_PREFIX = "9945ff10";
var RECIPIENT_MANAGER_OFFSET = 36;
var SEQUENCE_OFFSET = 70 + 24;
function isNttTransfer(payload) {
  return payload.subarray(0, 4).toString("hex") === NTT_TRANSFER_PREFIX;
}
function settlementSequence(payload) {
  return payload.readBigUInt64BE(SEQUENCE_OFFSET);
}
function isForManager(payload, manager) {
  const recipient = payload.subarray(RECIPIENT_MANAGER_OFFSET, RECIPIENT_MANAGER_OFFSET + 32).toString("hex");
  return recipient === (0, import_viem2.pad)(manager, { size: 32 }).slice(2).toLowerCase();
}

// src/engine/queue.ts
var import_viem3 = require("viem");
var MIN_GAS = 1000000n;
var CHAIN_NAMES = {
  1: "ethereum",
  8453: "base",
  222222: "hydration",
  11155111: "sepolia",
  84532: "base-sepolia"
};
function createQueue(deps) {
  const { publicClient, account } = deps;
  const warnMultiplier = deps.warnMultiplier ?? 50n;
  const pending = [];
  let nonce;
  let processing = false;
  let started = false;
  let lowBalanceWarned = false;
  let chainLabel;
  async function label() {
    if (chainLabel) return chainLabel;
    const id = await publicClient.getChainId();
    chainLabel = `${CHAIN_NAMES[id] ?? "chain"} (${id})`;
    return chainLabel;
  }
  async function notifyDiscord(message) {
    if (!deps.discordWebhook) return;
    try {
      await fetch(deps.discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message })
      });
    } catch (e) {
      logger_default.error(`Failed to send Discord notification: ${e.message}`);
    }
  }
  async function checkBalance() {
    const [balance, gasPrice, chain] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getGasPrice(),
      label()
    ]);
    const minBalance = gasPrice * MIN_GAS;
    const warnBalance = minBalance * warnMultiplier;
    const multiplier = minBalance > 0n ? Number(balance * 100n / minBalance) / 100 : 0;
    const pct = Math.min(100, Math.round(multiplier / Number(warnMultiplier) * 100));
    const bar = "\u2588".repeat(Math.round(pct / 100 * 20)) + "\u2591".repeat(20 - Math.round(pct / 100 * 20));
    const summary = `${chain} | \`${account.address}\` | ${multiplier.toFixed(1)}x/${warnMultiplier}x [${bar}] ${pct}% | ${(+(0, import_viem3.formatEther)(balance)).toFixed(4)} ETH @ ${(+(0, import_viem3.formatGwei)(gasPrice)).toFixed(2)} gwei`;
    if (balance < minBalance) {
      const msg = `KILL out of gas | ${summary}`;
      logger_default.error(msg);
      if (started) await notifyDiscord(msg);
      process.exit(1);
    }
    if (balance < warnBalance) {
      if (!lowBalanceWarned) {
        const msg = `WARN low gas | ${summary}`;
        logger_default.warn(msg);
        await notifyDiscord(msg);
        lowBalanceWarned = true;
      }
    } else {
      lowBalanceWarned = false;
    }
    logger_default.info(`Gas: ${summary}`);
  }
  function isDone(text) {
    return text.includes("transfer already completed") || text.includes("already been redeemed") || text.includes("VAA already processed") || text.includes("AlreadyRedeemed") || text.includes("TransferAlreadyCompleted");
  }
  async function drain() {
    if (processing || pending.length === 0) return;
    processing = true;
    const task = pending.shift();
    try {
      const hash = await task.submit(nonce);
      task.logger.info(`${task.label} submitted in ${hash}`);
      task.logger.info(`Next nonce: ${++nonce}`);
      void task.next();
    } catch (e) {
      const text = JSON.stringify(e, (_, v) => typeof v === "bigint" ? v.toString() : v) + (e.message ?? "");
      if (isDone(text)) {
        task.logger.info(`${task.label} already completed`);
        void task.next();
      } else if (text.includes("nonce too low")) {
        task.logger.info("nonce too low, reloading");
        nonce = await publicClient.getTransactionCount({ address: account.address });
        pending.unshift(task);
      } else {
        task.logger.error(`${task.label}: ${e.message ?? e}`);
        void task.next();
      }
    } finally {
      processing = false;
      await checkBalance();
      void drain();
    }
  }
  return {
    /** Load the starting nonce and assert the wallet can pay. Call once before listening. */
    async init() {
      await checkBalance();
      started = true;
      nonce = await publicClient.getTransactionCount({ address: account.address });
      return nonce;
    },
    add(task) {
      pending.push(task);
      void drain();
    },
    get nonce() {
      return nonce;
    }
  };
}

// src/utils/fees.ts
async function priorityFee(client) {
  try {
    const hex = await client.request({
      method: "eth_maxPriorityFeePerGas",
      params: []
    });
    return BigInt(hex);
  } catch {
    return 0n;
  }
}
async function hydrationFees(client) {
  const block = await client.getBlock();
  if (!block.baseFeePerGas) {
    return { kind: "legacy", gasPrice: await client.getGasPrice() };
  }
  const maxPriorityFeePerGas = await priorityFee(client);
  return {
    kind: "eip1559",
    maxPriorityFeePerGas,
    maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas
  };
}

// src/features/hydration-ntt/routes.ts
var CHAIN = {
  solana: 1,
  ethereum: 2,
  sui: 21,
  base: 30,
  hydration: 73
};
var NTT_ROUTES = [
  {
    token: "DAI",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0x99673a01C5779Ebf59399B4B228c1825c0113571",
    manager: "0xcFd576F88C90844AEBF45378Fd09931281D8b14d",
    transceiver: "0xe8660CA48f6f4D98BC48DB7Dd07C1a8E555801eA"
  },
  {
    token: "WBTC",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0x3FE8fBB8505c8dB2264f6Ebc5559c7C2b2647218",
    manager: "0x6BFca089916c045b0Ca4A09B655aF9F926189993",
    transceiver: "0x9a8a1ab288f6749Ce5626DEE1B5d59441BdC187F"
  },
  {
    token: "WETH",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0xbA0Cd32131b8206AF4feB79A1A3aaF0AEfe18b48",
    manager: "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7",
    transceiver: "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae"
  },
  {
    token: "USDC",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0xA108BD5dBc6CE665aEbB6895351e0609c76F8EFc",
    manager: "0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC",
    transceiver: "0x0d7488B39AA64468a709eC3b3d354DeFE539eD97"
  },
  {
    token: "USDT",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0x45c566f6595CF93e639E77cc1bbE57A8D27901c2",
    manager: "0x5E6C488103b47F804824AE15861638af4C436795",
    transceiver: "0xd2a16B736F32Df7C0DE72838837656FE0f85Ac0F"
  },
  {
    token: "sUSDS",
    sourceChain: CHAIN.ethereum,
    sourceEmitter: "0x7C236d237BEbBE1b7902131B31b7b3270005a810",
    manager: "0x1973E7044d9A7C7bB2d6ea1693A296a9e4B7E448",
    transceiver: "0x68Ecadd7934D4FcFEABAfB209C95D379B96400cb"
  },
  {
    token: "EURC",
    sourceChain: CHAIN.base,
    sourceEmitter: "0xa84b362290b0CFdB55e877dfc633284091e0B3F7",
    manager: "0x8dd1286A29dF5a2785FB638d6fB1598144Cfbc4C",
    transceiver: "0x2e84fac378D67Dc2e11026fB4919E80263a87375"
  },
  {
    token: "SOL",
    sourceChain: CHAIN.solana,
    sourceEmitter: "DiGxk55uAQNVzzg2FucPgdrQ4azb5SDvWQvzpzJD3o7J",
    manager: "0x9e200C0f28D92D296b201D96C8269d3CAFFfA9FF",
    transceiver: "0x2F04AcF249091425d51e67EeA3C3161ccE283202"
  },
  {
    token: "jitoSOL",
    sourceChain: CHAIN.solana,
    sourceEmitter: "9HFvXujdkXubvmf93gyzkH1g3VPowDrmp85sWsfdcBTh",
    manager: "0xcE73C15B9ED02413066DE5B904A36F8e8f9B5331",
    transceiver: "0xF38D9C3bA6999Dc331b32B416083Fd7e02D17B04"
  },
  {
    token: "PRIME",
    sourceChain: CHAIN.solana,
    sourceEmitter: "4T5m5NtRVewiCVzP2mnfeUoMYRqncfkrS21X2dhVCNRT",
    manager: "0xFCaF4aA069C565d25539028970703F01e47D3E0B",
    transceiver: "0x4e7b1E55D2354d4Dc6ABD876096Dc201de0541D1"
  },
  {
    token: "SUI",
    sourceChain: CHAIN.sui,
    // Sui VAAs use the EmitterCap id from the deployment manifest, not a contract address.
    sourceEmitter: "0x6afb4a6a9c4e5b6eeed568381ce95a79590f0c17ab8d0c59295826f2775bf832",
    manager: "0x978443f00cAB6b09445140321EC73a221ebFF5F8",
    transceiver: "0xA224D6f4e0E276b34D91bfE6c3A5fE6838322AF7"
  }
];

// src/features/hydration-ntt/index.ts
var transceiverAbi = (0, import_viem4.parseAbi)([
  "function receiveMessage(bytes encodedMessage) external",
  "error TransferAlreadyCompleted(bytes32 vaaHash)"
]);
var hydrationChain = (0, import_viem4.defineChain)({
  id: HYDRATION_EVM_CHAIN_ID,
  name: "Hydration",
  nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
  rpcUrls: { default: { http: [] } }
});
function hydrationNttFeature() {
  return { name: "hydration-ntt", start };
}
async function start() {
  const cfg = hydrationConfig();
  const account = (0, import_accounts.privateKeyToAccount)(cfg.privateKey);
  const publicClient = (0, import_viem4.createPublicClient)({ chain: hydrationChain, transport: (0, import_viem4.http)(cfg.rpc) });
  const wallet = (0, import_viem4.createWalletClient)({ account, chain: hydrationChain, transport: (0, import_viem4.http)(cfg.rpc) });
  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`HYDRATION_RPC returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }
  const queue = createQueue({
    publicClient,
    account,
    discordWebhook: cfg.discordWebhook,
    warnMultiplier: cfg.warnMultiplier
  });
  const nonce = await queue.init();
  logger_default.info("Hydration NTT relayer starting");
  logger_default.info(`  account: ${account.address} (nonce ${nonce})`);
  logger_default.info(`  watching ${NTT_ROUTES.length} NTT routes`);
  async function deliver(route, vaaBytes, nonce2) {
    const args = [`0x${vaaBytes.toString("hex")}`];
    await publicClient.simulateContract({
      address: route.transceiver,
      abi: transceiverAbi,
      functionName: "receiveMessage",
      args,
      account
    });
    const fees = await hydrationFees(publicClient);
    const call = {
      address: route.transceiver,
      abi: transceiverAbi,
      functionName: "receiveMessage",
      args,
      nonce: nonce2,
      chain: hydrationChain,
      account
    };
    return fees.kind === "legacy" ? wallet.writeContract({ ...call, gasPrice: fees.gasPrice }) : wallet.writeContract({
      ...call,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    });
  }
  async function handle(route, ctx, next) {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger.child({
      token: route.token,
      sourceTxHash,
      emitterChain: vaa.emitterChain,
      sequence: vaa.sequence.toString()
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
      submit: (n) => deliver(route, vaa.bytes, n)
    });
  }
  const app = makeApp(engineConfig(), {
    name: cfg.name,
    retries: cfg.retries,
    startingSequence: {
      [CHAIN.ethereum]: cfg.fromSequence.ethereum,
      [CHAIN.base]: cfg.fromSequence.base,
      [CHAIN.solana]: cfg.fromSequence.solana,
      [CHAIN.sui]: cfg.fromSequence.sui
    }
  });
  for (const route of NTT_ROUTES) {
    app.chain(route.sourceChain).address(route.sourceEmitter, ((ctx, next) => handle(route, ctx, next)));
  }
  await app.listen();
}

// src/features/intent/index.ts
var import_viem8 = require("viem");
var import_accounts2 = require("viem/accounts");
var import_chains = require("viem/chains");

// src/config/intent.ts
var HYDRATION_CHAIN = 73;
function intentConfig() {
  return {
    /**
     * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the
     * existing queue and missed-VAA cursors. See engine/app.ts.
     */
    name: opt("INTENT_APP_NAME", "intent-relayer"),
    /** Reimbursed signing wallet, separate from the generic relayer key. */
    privateKey: reqPrivateKey("INTENT_PRIVKEY"),
    /** WormholeTransceiver (WETH) on Hydration — publishes the settlement we subscribe to. */
    transceiver: reqAddress("NTT_TRANSCEIVER"),
    /** IntentEmitter on Hydration — publishes the forwarding instruction beside each settlement. */
    emitter: reqAddress("INTENT_EMITTER"),
    /** IntentReceiver proxy on Ethereum. */
    receiver: reqAddress("INTENT_RECEIVER"),
    ethRpc: opt("ETH_RPC", "https://eth.llamarpc.com"),
    /** Reads the source tx receipt to find the instruction the emitter published. */
    hydrationRpc: opt("HYDRATION_RPC", "https://hydration-rpc.n.dwellir.com"),
    quoterUrl: opt("QUOTER_URL", "http://localhost:8080"),
    /** Passed to the quoter so the fee reflects what processOrder actually costs. */
    gasLimit: opt("INTENT_GAS_LIMIT", "500000"),
    /** Cold-start floor; ignored once a safeSequence exists in Redis. */
    fromSequence: BigInt(opt("HYDRATION_FROM_SEQ", "0")),
    /**
     * Re-quote and retry an unprofitable order before dropping it — gas can fall within minutes, so
     * a fee currently above the user's maxRelayFee may become payable shortly. Retries ride the
     * engine's Redis-backed delayed queue, so they survive restarts. Backoff is
     * min(2^attempt * base, max): 2, 4, 8, 16, 32, 64 min. The age cap is the real terminator;
     * retries is a ceiling so nothing sticks forever.
     */
    retries: optNum("INTENT_RETRIES", 8),
    retryBaseMs: optNum("INTENT_RETRY_BASE_MS", 6e4),
    retryMaxMs: optNum("INTENT_RETRY_MAX_MS", 70 * 6e4),
    maxVaaAgeMs: optNum("INTENT_MAX_VAA_AGE_MS", 60 * 6e4),
    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50"))
  };
}

// src/engine/emitter.ts
var import_viem5 = require("viem");
function onEmitter(app, chain, emitter, handler) {
  const key = (0, import_viem5.pad)(emitter, { size: 32 }).slice(2).toLowerCase();
  const router = app.chain(chain);
  router._addressHandlers[key] = handler;
}

// src/engine/vaa.ts
var WORMHOLESCAN = "https://api.wormholescan.io/api/v1";
var apiKey = process.env.WORMHOLE_API_KEY;
async function loadVaa(chain, emitter, sequence) {
  const res = await fetch(`${WORMHOLESCAN}/vaas/${chain}/${emitter}/${sequence}`, {
    headers: apiKey ? { "X-API-KEY": apiKey } : {}
  });
  if (!res.ok) throw new Error(`wormholescan ${res.status} for ${chain}/${emitter}/${sequence}`);
  const body = await res.json();
  if (!body.data) throw new Error(`no VAA at ${chain}/${emitter}/${sequence}`);
  return {
    bytes: Buffer.from(body.data.vaa, "base64"),
    sourceTxHash: body.data.txHash
  };
}
async function fetchVaa(ctx, chain, emitter, sequence) {
  try {
    const vaa = await ctx.fetchVaa(chain, Buffer.from(emitter, "hex"), sequence);
    return Buffer.from(vaa.bytes);
  } catch {
    logger_default.info(`fetchVaa failed for ${chain}/${emitter}/${sequence}, trying Wormholescan`);
    const { bytes } = await loadVaa(chain, emitter, sequence);
    return bytes;
  }
}
function normalizeTxHash(hash) {
  return hash.startsWith("0x") ? hash : `0x${hash}`;
}

// src/features/intent/abi.ts
var import_viem6 = require("viem");
var receiverAbi = (0, import_viem6.parseAbi)([
  "function processOrder(bytes nttVaa, bytes instructionVaa, uint256 feeRequested) external",
  "error AlreadyRedeemed()",
  "error SequenceMismatch(uint64 instructed, uint64 settled)",
  "error NotFunded(uint256 required, uint256 available)",
  "error FeeExceedsCeiling()",
  "error UnauthorizedEmitter(uint16 chainId, bytes32 emitter)"
]);
var coreBridgeAbi = (0, import_viem6.parseAbi)([
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)"
]);
var instructionAbi = [
  { type: "uint64" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" }
];

// src/features/intent/instruction.ts
var import_viem7 = require("viem");
var LOG_MESSAGE_PUBLISHED = (0, import_viem7.toEventSelector)(coreBridgeAbi[0]);
async function findInstruction(client, emitter, txHash, sequence) {
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const emitterTopic = (0, import_viem7.pad)(emitter, { size: 32 }).toLowerCase();
  for (const log of receipt.logs) {
    if (log.topics[0] !== LOG_MESSAGE_PUBLISHED) continue;
    if ((log.topics[1] ?? "").toLowerCase() !== emitterTopic) continue;
    const { args } = (0, import_viem7.decodeEventLog)({
      abi: coreBridgeAbi,
      eventName: "LogMessagePublished",
      topics: log.topics,
      data: log.data
    });
    const [instructed, depositAddress, amount, maxRelayFee] = (0, import_viem7.decodeAbiParameters)(
      instructionAbi,
      args.payload
    );
    if (instructed !== sequence) continue;
    return { messageSequence: args.sequence, depositAddress, amount, maxRelayFee };
  }
  return null;
}

// src/features/intent/quote.ts
async function quoteRelayFee(cfg) {
  const url = `${cfg.quoterUrl}/relay-fee?chain=ethereum&feeAsset=native&gasLimit=${cfg.gasLimit}&marginBps=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quoter ${res.status}: ${await res.text()}`);
  const { feeRequested } = await res.json();
  return BigInt(feeRequested);
}

// src/features/intent/index.ts
function intentFeature() {
  return { name: "intent", start: start2 };
}
async function start2() {
  const cfg = intentConfig();
  const account = (0, import_accounts2.privateKeyToAccount)(cfg.privateKey);
  const eth = (0, import_viem8.createPublicClient)({ chain: import_chains.mainnet, transport: (0, import_viem8.http)(cfg.ethRpc) });
  const wallet = (0, import_viem8.createWalletClient)({ account, chain: import_chains.mainnet, transport: (0, import_viem8.http)(cfg.ethRpc) });
  const hydration = (0, import_viem8.createPublicClient)({ transport: (0, import_viem8.http)(cfg.hydrationRpc) });
  const queue = createQueue({
    publicClient: eth,
    account,
    discordWebhook: cfg.discordWebhook,
    warnMultiplier: cfg.warnMultiplier
  });
  const emitterHex = (0, import_viem8.pad)(cfg.emitter, { size: 32 }).slice(2);
  const nonce = await queue.init();
  logger_default.info("Intent relayer starting");
  logger_default.info(`  account:     ${account.address} (nonce ${nonce})`);
  logger_default.info(`  transceiver: ${cfg.transceiver} @ hydration`);
  logger_default.info(`  emitter:     ${cfg.emitter} @ hydration`);
  logger_default.info(`  receiver:    ${cfg.receiver} @ ethereum`);
  logger_default.info(`  quoter:      ${cfg.quoterUrl}`);
  async function forward(nttVaa, instructionVaa, fee, nonce2) {
    const args = [
      `0x${nttVaa.toString("hex")}`,
      `0x${instructionVaa.toString("hex")}`,
      fee
    ];
    await eth.simulateContract({
      address: cfg.receiver,
      abi: receiverAbi,
      functionName: "processOrder",
      args,
      account
    });
    return wallet.writeContract({
      address: cfg.receiver,
      abi: receiverAbi,
      functionName: "processOrder",
      args,
      nonce: nonce2,
      chain: import_chains.mainnet,
      account
    });
  }
  async function handle(ctx, next) {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger.child({ sourceTxHash, sequence: vaa.sequence.toString() });
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
      normalizeTxHash(sourceTxHash),
      sequence
    );
    if (!order) {
      log.info(`Settlement ${sequence} carries no instruction`);
      return next();
    }
    const ageMin = Math.round((Date.now() - vaa.timestamp * 1e3) / 6e4);
    if (ageMin * 6e4 > cfg.maxVaaAgeMs) {
      log.info(`Order ${sequence} stale (${ageMin}m > ${cfg.maxVaaAgeMs / 6e4}m)`);
      return next();
    }
    const attempt = ctx.storage?.job?.attempts ?? 0;
    const fee = await quoteRelayFee(cfg);
    if (fee > order.maxRelayFee) {
      throw new Error(
        `Order ${sequence} unprofitable (attempt ${attempt}/${cfg.retries}): fee ${fee} > ceiling ${order.maxRelayFee}; retrying with backoff`
      );
    }
    const instructionVaa = await fetchVaa(ctx, HYDRATION_CHAIN, emitterHex, order.messageSequence);
    log.info(
      `Order ${sequence}: ${order.amount} wei -> ${order.depositAddress}, fee ${fee} <= ${order.maxRelayFee} (attempt ${attempt}/${cfg.retries})`
    );
    queue.add({
      label: `order ${sequence}`,
      logger: log,
      next,
      submit: (n) => forward(vaa.bytes, instructionVaa, fee, n)
    });
  }
  const app = makeApp(engineConfig(), {
    name: cfg.name,
    retries: cfg.retries,
    backoff: { baseMs: cfg.retryBaseMs, maxMs: cfg.retryMaxMs },
    startingSequence: { [HYDRATION_CHAIN]: cfg.fromSequence }
  });
  onEmitter(app, HYDRATION_CHAIN, cfg.transceiver, handle);
  await app.listen();
}

// src/features/oracle/index.ts
var import_viem9 = require("viem");
var import_accounts3 = require("viem/accounts");

// src/config/oracle.ts
function oracleConfig() {
  return {
    /**
     * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the
     * existing queue and missed-VAA cursors. See engine/app.ts.
     */
    name: opt("ORACLE_APP_NAME", "oracle-relayer"),
    privateKey: reqPrivateKey("ORACLE_PRIVKEY"),
    rpc: opt("HYDRATION_RPC", "https://hydration-rpc.n.dwellir.com"),
    /** Cold-start floors per origin chain; ignored once a safeSequence exists in Redis. */
    fromSequence: {
      solana: BigInt(opt("ORACLE_SOLANA_FROM_SEQ", "0")),
      ethereum: BigInt(opt("ORACLE_ETH_FROM_SEQ", "0"))
    },
    discordWebhook: process.env.DISCORD_WEBHOOK_URL,
    warnMultiplier: BigInt(opt("GAS_WARN_MULTIPLIER", "50")),
    retries: optNum("ORACLE_RETRIES", 8)
  };
}

// src/features/oracle/routes.ts
var CHAIN2 = {
  solana: 1,
  ethereum: 2
};
var ORACLE_ROUTES = [
  {
    source: "solana",
    sourceChain: CHAIN2.solana,
    sourceEmitter: "AN6yxTepWFFjQWbo4448bNHHQR1Je48ppTkgBEpZ1SoJ",
    receiver: "0x582e2fac5af62dc024396b5e7f549c72273a69c3"
  },
  {
    source: "ethereum",
    sourceChain: CHAIN2.ethereum,
    sourceEmitter: "0xfbf682642a6a28760e717b637f12d014bd5db4b9",
    receiver: "0x6913770466fed4dbc24337cd7f1ae92af4321083"
  }
];

// src/features/oracle/index.ts
var receiverAbi2 = (0, import_viem9.parseAbi)(["function receiveMessage(bytes vaa) external"]);
var hydrationChain2 = (0, import_viem9.defineChain)({
  id: HYDRATION_EVM_CHAIN_ID,
  name: "Hydration",
  nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
  rpcUrls: { default: { http: [] } }
});
function oracleFeature() {
  return { name: "oracle", start: start3 };
}
async function start3() {
  const cfg = oracleConfig();
  const account = (0, import_accounts3.privateKeyToAccount)(cfg.privateKey);
  const publicClient = (0, import_viem9.createPublicClient)({ chain: hydrationChain2, transport: (0, import_viem9.http)(cfg.rpc) });
  const wallet = (0, import_viem9.createWalletClient)({ account, chain: hydrationChain2, transport: (0, import_viem9.http)(cfg.rpc) });
  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`HYDRATION_RPC returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }
  const queue = createQueue({
    publicClient,
    account,
    discordWebhook: cfg.discordWebhook,
    warnMultiplier: cfg.warnMultiplier
  });
  const nonce = await queue.init();
  logger_default.info("Oracle relayer starting");
  logger_default.info(`  account: ${account.address} (nonce ${nonce})`);
  for (const route of ORACLE_ROUTES) {
    logger_default.info(`  ${route.source} ${route.sourceEmitter} -> ${route.receiver}`);
  }
  async function deliver(route, vaaBytes, nonce2) {
    const args = [`0x${vaaBytes.toString("hex")}`];
    await publicClient.simulateContract({
      address: route.receiver,
      abi: receiverAbi2,
      functionName: "receiveMessage",
      args,
      account
    });
    const fees = await hydrationFees(publicClient);
    const call = {
      address: route.receiver,
      abi: receiverAbi2,
      functionName: "receiveMessage",
      args,
      nonce: nonce2,
      chain: hydrationChain2,
      account
    };
    return fees.kind === "legacy" ? wallet.writeContract({ ...call, gasPrice: fees.gasPrice }) : wallet.writeContract({
      ...call,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas
    });
  }
  async function handle(route, ctx, next) {
    const { vaa, sourceTxHash } = ctx;
    const log = ctx.logger.child({
      source: route.source,
      sourceTxHash,
      sequence: vaa.sequence.toString()
    });
    queue.add({
      label: `${route.source} oracle`,
      logger: log,
      next,
      submit: (n) => deliver(route, vaa.bytes, n)
    });
  }
  const app = makeApp(engineConfig(), {
    name: cfg.name,
    retries: cfg.retries,
    startingSequence: {
      [CHAIN2.solana]: cfg.fromSequence.solana,
      [CHAIN2.ethereum]: cfg.fromSequence.ethereum
    }
  });
  for (const route of ORACLE_ROUTES) {
    app.chain(route.sourceChain).address(route.sourceEmitter, ((ctx, next) => handle(route, ctx, next)));
  }
  await app.listen();
}

// src/index.ts
var BANNER = String.raw`
 ██████╗ ███████╗██╗      █████╗ ██╗   ██╗███████╗██████╗
 ██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗
 ██████╔╝█████╗  ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝
 ██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗
 ██║  ██║███████╗███████╗██║  ██║   ██║   ███████╗██║  ██║
 ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
        Wormhole vaa relayer
`;
function enabled() {
  const features = [];
  if (process.env.INTENT_PRIVKEY) features.push(intentFeature());
  if (process.env.PRIVKEY) features.push(hydrationNttFeature());
  if (process.env.ORACLE_PRIVKEY) features.push(oracleFeature());
  return features;
}
async function main() {
  console.log(BANNER);
  restoreNativeFetch();
  const features = enabled();
  if (features.length === 0) {
    throw new Error("Nothing to run: set INTENT_PRIVKEY, PRIVKEY and/or ORACLE_PRIVKEY.");
  }
  logger_default.info(`Relayer starting: ${features.map((f) => f.name).join(", ")}`);
  await Promise.all(features.map((f) => f.start()));
}
main().catch((err) => {
  logger_default.error("fatal:", err);
  process.exit(1);
});
//# sourceMappingURL=index.js.map
