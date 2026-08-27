/**
 * Shared page helpers. No framework and no build step — every page is one file the server reads at
 * boot, so this stays small enough to be read in one sitting.
 */

/** Theme, remembered per browser under the same key the explorer uses. */
export const theme = {
  KEY: "explorer-theme",
  init() {
    const btn = document.querySelector(".theme");
    if (!btn) return;
    const paint = () => {
      btn.textContent = document.documentElement.dataset.theme === "light" ? "◐" : "◑";
    };
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(theme.KEY, next);
      } catch {}
      paint();
    });
    paint();
  },
};

/**
 * Fetch JSON, returning null rather than throwing — a page renders "—" far better than a blank
 * screen with an error in the console.
 *
 * @param {string} url
 */
export async function json(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Subscribe to the domain's row changes and flip the connection dot.
 *
 * @param {string} flow Flow name to filter to.
 * @param {(update: object) => void} onUpdate
 */
export function live(flow, onUpdate) {
  const dot = document.querySelector(".conn .dot");
  const label = document.querySelector(".conn .label");
  const es = new EventSource(`/api/events?flow=${encodeURIComponent(flow)}`);
  const mark = (up) => {
    if (dot) dot.classList.toggle("live", up);
    if (label) label.textContent = up ? "live" : "reconnecting";
  };
  es.onopen = () => mark(true);
  es.onerror = () => mark(false);
  for (const kind of ["created", "updated"]) {
    es.addEventListener(kind, (e) => {
      try {
        onUpdate(JSON.parse(e.data));
      } catch {}
    });
  }
  return es;
}

/** Shorten a hash or address to its ends, which is all anyone reads. */
export function short(v, head = 6, tail = 4) {
  if (!v) return "—";
  const s = String(v);
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/**
 * Format a raw integer amount at a given precision.
 *
 * @param {string|number|bigint|null} raw
 * @param {number} decimals
 * @param {number} places Significant places to keep after the point.
 */
export function amount(raw, decimals = 18, places = 6) {
  if (raw === null || raw === undefined || raw === "") return "—";
  const neg = String(raw).startsWith("-");
  const digits = String(raw).replace("-", "");
  const pad = digits.padStart(decimals + 1, "0");
  const whole = pad.slice(0, pad.length - decimals) || "0";
  const frac = decimals ? pad.slice(pad.length - decimals).slice(0, places).replace(/0+$/, "") : "";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** Unix ms to a compact relative age. Block timestamps are ms, written at ingest. */
export function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Absolute time for a title attribute, where the exact moment matters. */
export function at(ms) {
  return ms ? new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) : "";
}

/** A state badge. */
export function badge(state) {
  return `<span class="badge ${state ?? ""}">${state ?? "—"}</span>`;
}

const EXPLORER = {
  ethereum: (tx) => `https://etherscan.io/tx/${tx}`,
  hydration: (tx) => `https://hydration.subscan.io/extrinsic/${tx}`,
};

/**
 * Link an event reference to the chain's own explorer. Hydration's EVM logs are substrate events,
 * so their "hash" is `blockHash-index` and only the block half is a real link.
 *
 * @param {{chain: string, txHash: string}|null} ref
 */
export function txLink(ref) {
  if (!ref) return "—";
  const url = EXPLORER[ref.chain]?.(ref.txHash.split("-")[0]);
  const text = short(ref.txHash.split("-")[0], 8, 6);
  return url ? `<a class="mono" href="${url}" target="_blank" rel="noreferrer">${text}</a>` : `<span class="mono">${text}</span>`;
}

/** Wormholescan link for a VAA id, which is already in its `chain/emitter/sequence` form. */
export function vaaLink(vaaId) {
  if (!vaaId) return "—";
  return `<a class="mono" href="https://wormholescan.io/#/tx/${vaaId}" target="_blank" rel="noreferrer">${vaaId}</a>`;
}

/** Escape untrusted text before it goes into innerHTML. */
export function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
