/**
 * Flow-tagged pub-sub for row changes. A flow broadcasts its own row shape; consumers — the SSE
 * stream, the startup logger — filter on `flow`.
 */
export interface RecordUpdate {
  flow: string;
  kind: "created" | "updated";
  /** the flow's row, serialized as-is to SSE clients */
  record: Record<string, unknown>;
  /** previous state on an update; null when the row is new */
  previousState?: string | null;
}

type Listener = (u: RecordUpdate) => void;

const listeners = new Set<Listener>();

/**
 * Register an update listener.
 *
 * @param fn Called on every broadcast.
 * @returns An unsubscribe function.
 */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fan an update out. A throwing listener is isolated so it cannot break the others.
 *
 * @param update The row change.
 */
export function broadcast(update: RecordUpdate): void {
  for (const fn of listeners) {
    try {
      fn(update);
    } catch {
      // a bad listener must not break the rest
    }
  }
}
