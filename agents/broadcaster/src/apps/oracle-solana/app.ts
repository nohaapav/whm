import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { boot } from "../../loop.js";
import type { Broadcaster, Feed } from "../../types.js";
import log from "../../logger.js";

import { RPC, signingKeypair } from "./config.js";
import idl from "./emitter/idl.json";
import type { OracleEmitter } from "./emitter/types.js";
import { assetIdStr, loadAllFeeds, type FeedEntry } from "./feeds.js";
import { readCurrentValue } from "./reader.js";
import { sendUpdate } from "./sender.js";
import { ROUTES, type ProgramRoute } from "./routes.js";

type SolanaFeed = Feed & { entry: FeedEntry; program: Program<OracleEmitter> };

/** One program per route; the IDL carries the default id, which the route overrides. */
function buildProgram(route: ProgramRoute, provider: anchor.AnchorProvider): Program<OracleEmitter> {
  return new Program<OracleEmitter>({ ...idl, address: route.programId } as OracleEmitter, provider);
}

function build(): Broadcaster {
  const keypair = signingKeypair();
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {
    commitment: "confirmed",
  });

  const programs = ROUTES.map((route) => ({ route, program: buildProgram(route, provider) }));
  for (const { route } of programs) {
    log.info(`  [${route.label}] program: ${route.programId}`);
  }
  log.info(`  signer: ${keypair.publicKey.toBase58()}`);

  return {
    name: "oracle-solana",

    async loadFeeds() {
      const feeds: SolanaFeed[] = [];
      for (const { route, program } of programs) {
        // Isolate routes: one program's startup failure must not take down the others.
        try {
          for (const entry of await loadAllFeeds(program)) {
            const asset = assetIdStr(entry.assetId);
            feeds.push({
              key: `${route.label}:${asset}`,
              asset,
              label: `${route.label}:${asset}`,
              entry,
              program,
            });
          }
        } catch (err) {
          log.error(`  [${route.label}] loadFeeds failed:`, err);
        }
      }
      return feeds;
    },

    read: (feed) => readCurrentValue(RPC, (feed as SolanaFeed).entry),
    send: (feed) => sendUpdate((feed as SolanaFeed).program, (feed as SolanaFeed).entry),
  };
}

boot(build);
