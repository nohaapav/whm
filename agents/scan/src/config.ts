/**
 * The whole env surface. Everything else — chain ids, contract addresses, start blocks, event
 * shapes — is code.
 */

/**
 * Read a required env var.
 *
 * @param name Variable name.
 * @throws When unset.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

export const databaseUrl = required("DATABASE_URL");
export const port = Number(process.env.PORT ?? 8080);

/** Backstop sweep for ingest; the real trigger is the chain's own head subscription. */
export const liveIntervalMs = Number(process.env.LIVE_POLL_INTERVAL_MS ?? 12_000);

/** Backstop drain for a flow; the real trigger is ingest nudging it. */
export const drainIntervalMs = Number(process.env.DRAIN_INTERVAL_MS ?? 5_000);

/** 1Click API JWT — the intents settlement poller is disabled without it. */
export const oneClickJwt = process.env.ONECLICK_JWT;

export const oneClickPollMs = Number(process.env.ONECLICK_POLL_MS ?? 15_000);
