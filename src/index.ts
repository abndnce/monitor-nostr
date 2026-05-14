import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ─── Env ────────────────────────────────────────────────────────────────────

const RELAYS = (process.env.NOSTR_RELAYS ?? "")
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);
const API_URL = process.env.FILTER_API_URL!;
const API_KEY = process.env.FILTER_API_KEY!;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const RESULTS = "latest.txt";
const TOP_N = 10;

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = "\u001b",
  RST = `${ESC}[0m`;
const COL_W = 3;

const A_GREEN = `${ESC}[42m  ${RST} `;
const A_WHITE = `${ESC}[47m  ${RST} `;
const A_BLACK = `${ESC}[40m  ${RST} `;

const T_GREEN = "## ";
const T_WHITE = "[] ";
const T_BLACK = "XX ";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusFrom(
  name: string,
  r: Record<string, unknown>,
  blocked: string[],
  unblocked: string[],
  errors: string[],
) {
  if (blocked.includes(name)) return "blocked";
  if (unblocked.includes(name)) return "unblocked";
  if (errors.includes(name)) return "error";
  if (typeof r.status === "string") {
    if (r.status === "Unblocked" || r.status === "Allowed") return "unblocked";
    if (r.status === "Blocked") return "blocked";
    return "error";
  }
  if (r.status === false) return "unblocked";
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
    const s = statusFrom(
      fname,
      fr as any,
      data.blocked,
      data.unblocked,
      data.errors,
    );
    filters.set(fname, s);
    if (s === "unblocked") score++;
  }
  return { url, filters, score };
}

function render(
  relays: { url: string; filters: Map<string, string>; score: number }[],
) {
  // ordered filter names
  const order = new Map<string, number>();
  for (const r of relays)
    for (const k of r.filters.keys())
      if (!order.has(k)) order.set(k, order.size);
  const names = [...order.keys()];

  // status matrix
  const rows = relays.map((r) =>
    names.map((n) => r.filters.get(n) ?? "blocked"),
  );

  // first unblocked per column
  const first = new Map<number, number>();
  for (let c = 0; c < names.length; c++)
    for (let r = 0; r < relays.length; r++)
      if (rows[r][c] === "unblocked") {
        first.set(c, r);
        break;
      }

  const nameW = Math.max(...relays.map((r) => r.url.length), "Relay".length);
  const short = (s: string) =>
    s.length <= COL_W ? s.padEnd(COL_W) : s.slice(0, COL_W - 1) + "…";
  const pad = (n: string, cells: string[]) =>
    n.padEnd(nameW) + "  " + cells.join("");

  const hPlain = pad("Relay", names.map(short));
  const sep =
    "".padEnd(nameW, "─") +
    "──" +
    names.map(() => "".padEnd(COL_W, "─")).join("");
  const hAnsi = pad(
    `${ESC}[1mRelay${RST}`,
    names.map((n) => `${ESC}[1m${short(n)}${RST}`),
  );

  const cell = (c: number, r: number, ansi: boolean) => {
    const g = first.get(c) === r && rows[r][c] === "unblocked";
    if (ansi)
      return g ? A_GREEN : rows[r][c] === "unblocked" ? A_WHITE : A_BLACK;
    return g ? T_GREEN : rows[r][c] === "unblocked" ? T_WHITE : T_BLACK;
  };

  const plain = [hPlain, sep];
  const ansi = [hAnsi, sep];
  for (let r = 0; r < relays.length; r++) {
    plain.push(
      pad(
        relays[r].url,
        names.map((_, c) => cell(c, r, false)),
      ),
    );
    ansi.push(
      pad(
        relays[r].url,
        names.map((_, c) => cell(c, r, true)),
      ),
    );
  }
  plain.push(
    "",
    `${T_GREEN}first unblocked`,
    `${T_WHITE}unblocked`,
    `${T_BLACK}blocked / error`,
  );
  ansi.push(
    "",
    `${A_GREEN}first unblocked`,
    `${A_WHITE}unblocked`,
    `${A_BLACK}blocked / error`,
  );

  return { plain: plain.join("\n"), ansi: ansi.join("\n") };
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`Checking ${RELAYS.length} relays...\n`);

const settled = await Promise.allSettled(RELAYS.map((url) => check(url)));

const results: { url: string; filters: Map<string, string>; score: number }[] = [];
for (let i = 0; i < settled.length; i++) {
  const r = settled[i];
  if (r.status === "fulfilled") {
    results.push(r.value);
  } else {
    console.error(`  ✗ ${RELAYS[i]}  — ${r.reason}`);
  }
}

if (results.length === 0) throw new Error("all relay checks failed");

results.sort((a, b) => b.score - a.score);
const top = results.slice(0, TOP_N);

console.log(`\nTop ${top.length} (of ${results.length} successful):`);
for (const r of top) console.log(`  ${r.url}  (${r.score})`);

const { plain, ansi } = render(top);
console.log("\n" + plain);

// compare
const prev = existsSync(RESULTS) ? readFileSync(RESULTS, "utf-8") : null;
if (prev === plain) {
  console.log("\nNo change.");
  process.exit(0);
}

writeFileSync(RESULTS, plain, "utf-8");
console.log(`\nSaved ${RESULTS}`);

// git (in CI)
if (process.env.CI === "true") {
  execSync('git config user.name "bot" && git config user.email "bot@local"', {
    shell: true,
  });
  execSync(`git add "${RESULTS}"`, { stdio: "inherit" });
  const dirty = execSync("git status --porcelain", {
    encoding: "utf-8",
  }).trim();
  if (dirty) {
    execSync(`git commit -m "update relay filter status [skip ci]"`, {
      stdio: "inherit",
    });
    execSync("git push", { stdio: "inherit" });
    console.log("Pushed.");
  }
}

// discord — send grid as a file to avoid the 2000-char content limit
if (WEBHOOK) {
  const summary = top.map((r, i) => `${i + 1}. ${r.url}  (${r.score}/${r.filters.size})`).join("\n");

  const form = new FormData();
  form.append("content", `**Nostr Relay Filter Monitor**\n${top.length} of ${results.length} relays shown\n\n${summary}`);
  form.append("file", new Blob([ansi], { type: "text/plain" }), "grid.ansi.txt");

  const res = await fetch(WEBHOOK, { method: "POST", body: form });
  if (!res.ok) console.error(`Discord: ${res.status} ${await res.text()}`);
  else console.log("Discord sent.");
}
