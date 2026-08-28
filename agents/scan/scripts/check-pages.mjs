/**
 * Run every page against a live API and assert it rendered.
 *
 * The pages are plain modules in HTML with no build step, so nothing type-checks them — a reference
 * to a variable that is out of scope, or a helper's output escaped twice, only shows up in a
 * browser. This imports each page's module body under a minimal DOM, points its fetches at a
 * running domain container, and waits for markup that proves the real branch ran rather than the
 * empty-state one.
 *
 *   pnpm check:pages [http://localhost:8080]
 *
 * The expectations below describe a database indexed from the current watch list. `no transfers`
 * for Basejump is the correct answer while its emitter is undeployed — an assertion that its list
 * is populated would be the wrong test, not a stricter one.
 */
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Captured before any page can replace them: undici schedules on real timers, and a stubbed
// setTimeout breaks fetch itself.
const REAL_FETCH = globalThis.fetch;
const REAL_SETTIMEOUT = globalThis.setTimeout;

const BASE = process.argv[2] ?? "http://localhost:8080";
const ROOT = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), "scan-pages-"));
const TIMEOUT_MS = 8_000;

/** Path to visit, and the markup that proves the page got there. */
const PAGES = [
  { dir: "intents", file: "index.html", path: "/", expect: "USDC" },
  { dir: "intents", file: "orders.html", path: "/orders/28", expect: "settlement id" },
  { dir: "intents", file: "quotes.html", path: "/quotes", expect: "Quotes" },
  { dir: "intents", file: "quotes.html", path: "/quotes/0xabc", expect: "no quote" },
  { dir: "basejump", file: "index.html", path: "/", expect: "no transfers" },
  { dir: "basejump", file: "transfers.html", path: "/transfers/none", expect: "no transfer" },
];

const sleep = (ms) => new Promise((r) => REAL_SETTIMEOUT(r, ms));

/**
 * Enough of a browser for a page to build its markup and for us to read it back.
 *
 * @param path The location the page thinks it is at.
 * @returns The elements it wrote to.
 */
function stubDom(path) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        textContent: "",
        value: "",
        disabled: false,
        innerHTML: "",
        addEventListener() {},
        insertAdjacentHTML() {},
        querySelector: () => null,
        closest: () => null,
        classList: { toggle() {} },
      });
    }
    return nodes.get(id);
  };

  globalThis.document = {
    body: { insertAdjacentHTML() {} },
    documentElement: { dataset: {}, setAttribute() {} },
    getElementById: node,
    querySelector: () => null,
  };
  globalThis.location = { pathname: path, href: "", replace() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.EventSource = class {
    addEventListener() {}
  };
  globalThis.fetch = (u, o) => REAL_FETCH(u.startsWith("http") ? u : BASE + u, o);

  return nodes;
}

/**
 * Import one page's module body and wait for it to render.
 *
 * @returns An error message, or null when it rendered what was expected.
 */
async function check({ dir, file, path, expect }) {
  const html = readFileSync(join(ROOT, "public", dir, file), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!script) return "no module script";

  const entry = join(WORK, `${dir}-${file}-${path.replace(/\W/g, "_")}.mjs`);
  writeFileSync(
    entry,
    script.replaceAll(
      '"/shared/app.js"',
      JSON.stringify(pathToFileURL(join(ROOT, "public", "shared", "app.js")).href),
    ),
  );

  const nodes = stubDom(path);
  const rendered = () => [...nodes.values()].map((n) => n.innerHTML).join("");

  const failures = [];
  const onRejection = (e) => failures.push(e);
  process.on("unhandledRejection", onRejection);
  try {
    await import(pathToFileURL(entry).href);
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && !rendered().includes(expect)) await sleep(50);
  } catch (e) {
    return e.message;
  } finally {
    process.off("unhandledRejection", onRejection);
  }

  if (failures.length) return failures[0]?.message ?? String(failures[0]);
  if (!rendered().includes(expect)) {
    return `never rendered ${JSON.stringify(expect)} (${rendered().length}b)`;
  }
  return null;
}

let failed = 0;
for (const page of PAGES) {
  const where = `${page.dir}/${page.file} ${page.path}`;
  const error = await check(page);
  if (error) {
    failed++;
    console.log(`  FAIL  ${where}: ${error}`);
  } else {
    console.log(`  ok    ${where}`);
  }
}

if (failed) {
  console.log(`\n${failed} page(s) failed. Is a domain container serving ${BASE}?`);
  process.exit(1);
}
console.log(`\nall pages rendered against ${BASE}`);
process.exit(0);
