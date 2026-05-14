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
  for (const ch of s) w += (ch === "🟩" || ch === "⬜" || ch === "⬛") ? 2 : 1;
  return w;
}
function dwPad(s: string, target: number) {
  const n = target - dw(s);
  return n > 0 ? s + " ".repeat(n) : s;
}

const GREEN = "🟩"; // first unblocked in column
const WHITE = "⬜"; // unblocked
const BLACK = "⬛"; // blocked / error

/** Build the grid lines (no filter-name header, just single letters). */
function grid(relays: { short: string; filters: Map<string, string>; score: number }[]) {
  const order = new Map<string, number>();
  for (const r of relays) for (const k of r.filters.keys()) if (!order.has(k)) order.set(k, order.size);
  const names = [...order.keys()];

  const rows = relays.map(r => names.map(n => r.filters.get(n) ?? "blocked"));

  const first = new Map<number, number>();
  for (let c = 0; c < names.length; c++)
    for (let r = 0; r < relays.length; r++)
      if (rows[r][c] === "unblocked") { first.set(c, r); break; }

  const nameW = Math.max(...relays.map(r => dw(r.short)), dw("Relay"));

  // Each column = 3 display columns: letter(1) + 2 spaces, or emoji(2) + 1 space
  const colH = (i: number) => dwPad(String.fromCharCode(65 + i), 3); // A, B, C…
  const colD = (c: number, r: number) => {
    const g = first.get(c) === r && rows[r][c] === "unblocked";
    const sq = g && rows[r][c] === "unblocked" ? GREEN : rows[r][c] === "unblocked" ? WHITE : BLACK;
    return sq + " "; // emoji(2) + space(1) = 3 dw
  };
  const pad = (n: string, cells: string[]) => dwPad(n, nameW) + "  " + cells.join("");

  const lines = [pad("Relay", names.map((_, i) => colH(i)))];
  for (let r = 0; r < relays.length; r++)
    lines.push(pad(relays[r].short, names.map((_, c) => colD(c, r))));

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`Checking ${RELAYS.length} relays...\n`);

const settled = await Promise.allSettled(RELAYS.map(url => check(url)));

const results: { url: string; short: string; filters: Map<string, string>; score: number }[] = [];
for (let i = 0; i < settled.length; i++) {
  const r = settled[i];
  if (r.status === "fulfilled") results.push(r.value);
  else console.error(`  ✗ ${RELAYS[i]}  — ${r.reason}`);
}
if (results.length === 0) throw new Error("all relay checks failed");

results.sort((a, b) => b.score - a.score);
const top = results.slice(0, TOP_N);

console.log(`\nTop ${top.length} (of ${results.length} successful):`);
for (const r of top) console.log(`  ${r.url}  (${r.score})`);

const g = grid(top);
console.log("\n" + g);

// compare (store full URLs for fidelity)
const fullGrid = grid(top.map(r => ({ ...r, short: r.url })));
const prev = existsSync(RESULTS) ? readFileSync(RESULTS, "utf-8") : null;
if (prev === fullGrid) { console.log("\nNo change."); process.exit(0); }

writeFileSync(RESULTS, fullGrid, "utf-8");
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
  // build letter→filter legend
  const order = new Map<string, number>();
  for (const r of top) for (const k of r.filters.keys()) if (!order.has(k)) order.set(k, order.size);
  const names = [...order.keys()];
  const legend = names.map((n, i) => `${String.fromCharCode(65 + i)}: ${n}`).join("  ");

  const msg = [
    "**Nostr Relay Filter Monitor**",
    `Top ${top.length} of ${results.length} relays`,
    "",
    "```",
    g,
    "```",
    `${GREEN} first unblocked   ${WHITE} unblocked   ${BLACK} blocked/error`,
    "",
    legend,
  ].join("\n");

  // emergency trim if needed
  const payload = msg.length > 2000 ? msg.slice(0, 1997) + "…" : msg;
  const res = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: payload }) });
  if (!res.ok) console.error(`Discord: ${res.status} ${await res.text()}`);
  else console.log("Discord sent.");
}
