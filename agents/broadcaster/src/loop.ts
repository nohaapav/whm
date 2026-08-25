import { HumanizeDuration, HumanizeDurationLanguage } from "humanize-duration-ts";

import { optNum } from "./config.js";
import log from "./logger.js";

import { hasChangedBeyondThreshold } from "./big.js";
import { loadState, loadThresholds, saveState, type BroadcasterState, type ThresholdMap } from "./state.js";
import type { Broadcaster, Feed } from "./types.js";

const langService = new HumanizeDurationLanguage();
const humanizer = new HumanizeDuration(langService);

const CHECK_INTERVAL_MS = 60 * 1_000;
const THRESHOLDS_FILE = "thresholds.json";

/** Per-app so two containers sharing a volume cannot overwrite each other's last-sent values. */
function stateFile(name: string): string {
  return `.db/${name}.json`;
}

function config() {
  return {
    changeThreshold: optNum("CHANGE_THRESHOLD", 0.1) / 100,
    fullRefreshMs: optNum("REFRESH_INTERVAL", 24) * 60 * 60 * 1_000,
  };
}

/**
 * Publish every feed whose last send is older than the full-refresh window.
 *
 * @param app The chain's broadcaster.
 * @param feeds Its feeds.
 * @param state Last-sent values, updated and persisted per feed.
 * @param fullRefreshMs How stale a send has to be to warrant republishing.
 */
async function broadcastAll(
  app: Broadcaster,
  feeds: Feed[],
  state: BroadcasterState,
  fullRefreshMs: number,
): Promise<void> {
  const now = Date.now();
  for (const feed of feeds) {
    const last = state[feed.key];
    if (last && now - last.sentAt < fullRefreshMs) {
      const ago = humanizer.humanize(now - last.sentAt, { round: true, largest: 1 });
      log.info(`[full-refresh] Skipping ${feed.label} (synced ${ago} ago)`);
      continue;
    }
    log.info(`[full-refresh] Broadcasting ${feed.label}`);
    try {
      const value = await app.read(feed);
      await app.send(feed);
      state[feed.key] = { value: value.toString(), sentAt: now };
      saveState(stateFile(app.name), state);
    } catch (err) {
      log.error(`[full-refresh] Failed for ${feed.label}:`, err);
    }
  }
}

/**
 * Publish only the feeds whose value moved past their threshold.
 *
 * @param app The chain's broadcaster.
 * @param feeds Its feeds.
 * @param state Last-sent values, updated and persisted per feed.
 * @param thresholds Per-asset overrides.
 * @param fallback Threshold for assets with no override.
 */
async function checkAndBroadcast(
  app: Broadcaster,
  feeds: Feed[],
  state: BroadcasterState,
  thresholds: ThresholdMap,
  fallback: number,
): Promise<void> {
  for (const feed of feeds) {
    const threshold = thresholds[feed.asset] ?? fallback;
    try {
      const current = await app.read(feed);
      const last = BigInt(state[feed.key]?.value ?? "0");

      if (!hasChangedBeyondThreshold(current, last, threshold)) {
        continue;
      }

      log.info(`[check] ${feed.label} changed: ${last} -> ${current}`);
      await app.send(feed);
      state[feed.key] = { value: current.toString(), sentAt: Date.now() };
      saveState(stateFile(app.name), state);
    } catch (err) {
      log.error(`[check] Failed for ${feed.label}:`, err);
    }
  }
}

/**
 * Run one broadcaster as the process: discover its feeds, publish them all once, then poll.
 *
 * @param app The chain's broadcaster.
 */
export async function run(app: Broadcaster): Promise<void> {
  const { changeThreshold, fullRefreshMs } = config();

  log.info(`Broadcaster starting: ${app.name}`);
  log.info(`  Check interval: ${CHECK_INTERVAL_MS / 1_000 / 60}m`);
  log.info(`  Full refresh: ${fullRefreshMs / 1_000 / 60 / 60}h`);
  log.info(`  Change threshold: ${changeThreshold * 100}%`);
  log.info(`  State file: ${stateFile(app.name)}`);

  const feeds = await app.loadFeeds();
  if (feeds.length === 0) {
    log.info("No feeds registered, nothing to do");
    process.exit(0);
  }

  const state = loadState(stateFile(app.name));
  const thresholds = loadThresholds(THRESHOLDS_FILE);
  for (const [asset, threshold] of Object.entries(thresholds)) {
    log.info(`  Threshold override: ${asset} = ${threshold * 100}%`);
  }

  await broadcastAll(app, feeds, state, fullRefreshMs);
  let lastFullRefresh = Date.now();

  const tick = async () => {
    const now = Date.now();

    if (now - lastFullRefresh >= fullRefreshMs) {
      await broadcastAll(app, feeds, state, fullRefreshMs);
      lastFullRefresh = now;
    } else {
      await checkAndBroadcast(app, feeds, state, thresholds, changeThreshold);
    }
  };

  setInterval(() => {
    tick().catch((err) => log.error("[tick] Unhandled error:", err));
  }, CHECK_INTERVAL_MS);

  log.info("Broadcaster agent running...");
}

/**
 * Run one app as the process.
 *
 * Each app is its own entry point and its own container, so there is nothing to select and no way
 * to end up running the wrong one: `dist/<app>/app.js` is the app.
 *
 * @param build Constructs the broadcaster. Anything it throws is fatal.
 */
export function boot(build: () => Broadcaster): void {
  let app: Broadcaster;
  try {
    app = build();
  } catch (err) {
    log.error("Fatal:", err);
    process.exit(1);
  }

  run(app).catch((err) => {
    log.error("Fatal:", err);
    process.exit(1);
  });
}
