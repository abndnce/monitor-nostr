import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ─── Env ────────────────────────────────────────────────────────────────────

const RELAYS  = (process.env.NOSTR_RELAYS ?? "").split("\n").map(s => s.trim()).filter(Boolean);
const API_URL = process.env.FILTER_API_URL!;
const API_KEY = process.env.FILTER_API_KEY!;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const RESULTS = "latest.txt";
const TOP_N   = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortUrl(u: string) {
  // strip wss:// and trailing /
  let s = u.replace(/^wss:\/\//, "").replace(/\/$/, "");
  // keep meaningful prefix, cap at ~30
  return s.length <= 30 ? s : s.slice(0, 27) + "…";
}

function statusFrom(name: string, r: Record<string, unknown>, blocked: string[], unblocked: string[], errors: string[]) {
  if (blocked.includes(name))   return "blocked";
  if (unblocked.includes(name)) return "unblocked";
  if (errors.includes(name))    return "error";
  if (typeof r.status === "string") {
    if (r.status === "Unblocked" || r.status === "Allowed") return "unblocked";
    if (r.status === "Blocked")   return "blocked";
    return "error";
  }
  if (r.status === false)       return "unblocked";
  if (typeof r.block === "boolean") return r.block ? "blocked" : "unblocked";
  return "blocked";
}

async function check(url: string) {
  const res = await fetch(`${API_URL}?url=${encodeURIComponent(url)}`, {
    headers: { "X-API-Key": API_KEY },
  });
  if (!res.ok) throw new Error(`API ${res.status} for ${url}`);
  const data: Record<string, any> = await res.json();

  const filters = new Map<string, string>();
  let score = 0;
  for (const [fname, fr] of Object.entries(data.results)) {
    const s = statusFrom(fname, fr as any, data.blocked, data.unblocked, data.errors);
    filters.set(fname, s);
    if (s === "unblocked") score++;
  }
  return { url, short: shortUrl(url), filters, score };
}

// display width: emoji squares count as 2, ascii as 1
function dw(s: string) {
  let w = 0;
  for (const ch of s) w += (ch === GREEN || ch === WHITE || ch === BLACK || ch === RED) ? 2 : 1;
  return w;
}
function dwPad(s: string, target: number) {
  const n = target - dw(s);
  return n > 0 ? s + " ".repeat(n) : s;
}

const GREEN = "🟩";
const WHITE = "⬜";
const BLACK = "⬛";
const RED   = "🟥";

// ─── Column-symbol assignment ────────────────────────────────────────────
// Try first-letter uppercase; fall back to a number, then to any remaining
// uppercase letter, then to any remaining lowercase letter.

function assignSymbols(names: string[]): Map<string, string> {
  const sym = new Map<string, string>();   // filterName → symbol string
  const used = new Set<string>();

  const pool: string[] = [];
  // numbers
  for (let i = 0; i <= 9; i++) pool.push(String(i));
  // remaining uppercase A-Z
  for (let i = 0; i < 26; i++) pool.push(String.fromCharCode(65 + i));
  // lowercase as last resort
  for (let i = 0; i < 26; i++) pool.push(String.fromCharCode(97 + i));

  let pi = 0; // pool index

  for (const name of names) {
    const pref = name[0].toUpperCase();
    if (!used.has(pref)) {
      sym.set(name, pref);
      used.add(pref);
      continue;
    }
    // fallback: next unused from pool
    while (pi < pool.length && used.has(pool[pi])) pi++;
    if (pi < pool.length) {
      sym.set(name, pool[pi]);
      used.add(pool[pi]);
      pi++;
    }
  }
  return sym;
}

function grid(relays: { url: string; short: string; filters: Map<string, string>; score: number }[]) {
  const order = new Map<string, number>();
  for (const r of relays) for (const k of r.filters.keys()) if (!order.has(k)) order.set(k, order.size);
  const names = [...order.keys()].sort();

  const cols = assignSymbols(names);           // filterName → display symbol
  const syms = names.map(n => cols.get(n)!);   // ordered symbols

  const rows = relays.map(r => names.map(n => r.filters.get(n) ?? "blocked"));

  // First-unblocked: skip test entries so they don't steal green squares
  const first = new Map<number, number>();
  for (let c = 0; c < names.length; c++)
    for (let r = 0; r < relays.length; r++)
      if (!isTest(relays[r]) && rows[r][c] === "unblocked") { first.set(c, r); break; }

  const nameW = Math.max(...relays.map(r => dw(r.short)), dw("Relay"));

  // Each data cell = emoji(2) + space(1) = 3 dw.
  // Header cell = symbol(1) + 2 spaces = 3 dw.
  const colH = (i: number) => dwPad(syms[i], 3);
  const colD = (c: number, r: number) => {
    const g = first.get(c) === r && rows[r][c] === "unblocked";
    const sq = g && rows[r][c] === "unblocked" ? GREEN : rows[r][c] === "unblocked" ? WHITE : rows[r][c] === "error" ? RED : BLACK;
    return sq + " ";
  };
  const pad = (n: string, cells: string[]) => dwPad(n, nameW) + "  " + cells.join("");

  const lines = [pad("Relay", names.map((_, i) => colH(i)))];
  for (let r = 0; r < relays.length; r++)
    lines.push(pad(relays[r].short, names.map((_, c) => colD(c, r))));

  return { lines: lines.join("\n"), syms: names.map((n, i) => `${syms[i]}: ${n}`) };
}

// ─── Test/special-cases ─────────────────────────────────────────────────

const TEST_DOMAINS = ["www.google.com"];

function isTest(relay: { url?: string }) {
  return relay.url ? TEST_DOMAINS.includes(relay.url) : false;
}

// ─── Ranking: first-unblocked coverage, then absolute score ──────────────

function rankTop(relays: { url: string; short: string; filters: Map<string, string>; score: number }[], n: number) {
  // Separate test entries (they shouldn't influence ranking)
  const testEntries = relays.filter(isTest);
  const realEntries = relays.filter(r => !isTest(r));

  // All unique filter names across all real relays
  const allFilters = new Set<string>();
  for (const r of realEntries) for (const k of r.filters.keys()) allFilters.add(k);
  const filterNames = [...allFilters].sort();

  const sorted: typeof relays = [];
  const remaining = [...realEntries];
  const claimed = new Set<string>(); // filters that already have a first unblocked

  while (sorted.length < n && remaining.length > 0) {
    let bestIdx = -1, bestNew = -1, bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      let newCount = 0;
      for (const f of filterNames) {
        if (!claimed.has(f) && r.filters.get(f) === "unblocked") newCount++;
      }
      if (newCount > bestNew || (newCount === bestNew && r.score > bestScore)) {
        bestNew = newCount;
        bestIdx = i;
        bestScore = r.score;
      }
    }

    if (bestIdx === -1) break;
    const picked = remaining.splice(bestIdx, 1)[0];

    // Mark filters this relay unblocked as claimed
    for (const f of filterNames) {
      if (!claimed.has(f) && picked.filters.get(f) === "unblocked") claimed.add(f);
    }

    sorted.push(picked);
  }

  // Fill remaining slots by absolute score (from real entries)
  remaining.sort((a, b) => b.score - a.score);
  while (sorted.length < n && remaining.length > 0) sorted.push(remaining.shift()!);

  // Prepend test entries so they appear first (but don't influence ranking)
  return [...testEntries, ...sorted];
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`Checking ${RELAYS.length} relays...\n`);

const results: { url: string; short: string; filters: Map<string, string>; score: number }[] = [];
for (const url of RELAYS) results.push(await check(url));

const top = rankTop(results, TOP_N);

console.log(`\nTop ${top.length} (of ${results.length} successful):`);
for (const r of top) console.log(`  ${r.url}  (${r.score})`);

const { lines: g, syms } = grid(top);
console.log("\n" + g);

// compare (store full URLs for fidelity)
const prevLines = grid(top.map(r => ({ ...r, short: r.url }))).lines;
const prev = existsSync(RESULTS) ? readFileSync(RESULTS, "utf-8") : null;
if (prev === prevLines) { console.log("\nNo change."); process.exit(0); }

writeFileSync(RESULTS, prevLines, "utf-8");
console.log(`\nSaved ${RESULTS}`);

// git (in CI)
if (process.env.CI === "true") {
  execSync('git config user.name "bot" && git config user.email "bot@local"', { shell: true });
  execSync(`git add "${RESULTS}"`, { stdio: "inherit" });
  const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
  if (dirty) {
    execSync(`git commit -m "update relay filter status [skip ci]"`, { stdio: "inherit" });
    execSync("git push", { stdio: "inherit" });
    console.log("Pushed.");
  }
}

// discord
if (WEBHOOK) {
  const legend = syms.join("  ");
  const msg = [
    "```",
    g,
    "```",
    `${GREEN} first unblocked   ${WHITE} unblocked   ${RED} error   ${BLACK} blocked`,
    "",
    legend,
  ].join("\n");

  const payload = msg.length > 2000 ? msg.slice(0, 1997) + "…" : msg;
  const res = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: payload }) });
  if (!res.ok) console.error(`Discord: ${res.status} ${await res.text()}`);
  else console.log("Discord sent.");
}
