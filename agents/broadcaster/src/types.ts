// Chain-agnostic feed + broadcaster contracts. Each app owns its chain's discovery / read / publish
// across its own routes; core/loop.ts polls the flat feed list they produce.

export interface Feed {
  /** Unique across every route — the state key. */
  key: string;
  /** The asset this feed carries, shared by every route publishing it — the thresholds.json key. */
  asset: string;
  /** For logs. */
  label: string;
}

export interface Broadcaster {
  name: string;
  loadFeeds(): Promise<Feed[]>;
  read(feed: Feed): Promise<bigint>;
  send(feed: Feed): Promise<string>;
}
