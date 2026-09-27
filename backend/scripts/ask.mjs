#!/usr/bin/env node
/// Ask Jev the rat's protocol once and print the typed answer — the 10-second check that
/// TYPESAFE_API_KEY works before the engine goes live.
///
///   node scripts/ask.mjs                 a made-up quiet market
///   node scripts/ask.mjs dump            a made-up sell-off
///   node scripts/ask.mjs pump            a made-up run
///   node scripts/ask.mjs --raw           print the raw HTTP response instead
import { config } from "../src/config.js";
import { decide, PROTOCOL } from "../src/jev.js";

const scenario = process.argv.find((a) => ["dump", "pump"].includes(a)) || "quiet";
const STATES = {
  quiet: { price_change_pct: { m3: 0.2, m15: -0.8, h1: 1.1 }, flow: { buys: 2, sells: 1, buy_usd: 60, sell_usd: 25, wallets: 3 }, pot: { usd: 4.1, pct_of_market_cap: 0.006 } },
  dump: { price_change_pct: { m3: -9.4, m15: -21.0, h1: -18.2 }, flow: { buys: 3, sells: 19, buy_usd: 140, sell_usd: 2900, wallets: 17 }, pot: { usd: 96, pct_of_market_cap: 0.17 } },
  pump: { price_change_pct: { m3: 7.9, m15: 24.5, h1: 61.0 }, flow: { buys: 31, sells: 8, buy_usd: 5200, sell_usd: 900, wallets: 29 }, pot: { usd: 180, pct_of_market_cap: 0.12 } },
};
const state = {
  coin: { symbol: "LABRAT", market_cap_usd: scenario === "quiet" ? 68000 : scenario === "dump" ? 56000 : 150000, venue: "bonding curve", supply_burned_pct: 1.2 },
  holders: { count: 412, in_the_draw: 100, top10_pct_of_supply: 21.4, draw_pct_of_supply: 58.0 },
  ...STATES[scenario],
  recent_trials: [{ action: "burn", by: "jev", price_change_after_pct: 1.4 }, { action: "bless", by: "jev", price_change_after_pct: -0.3 }],
  results_so_far: { burn: { trials: 12, avg_price_change_after_pct: 0.9 }, bless: { trials: 7, avg_price_change_after_pct: 0.4 }, stash: { trials: 4, avg_price_change_after_pct: 0.1 } },
};

if (!config.jev.apiKey) { console.error("TYPESAFE_API_KEY is not set (backend/.env) — get one at console.typesafe.ai/settings/keys"); process.exit(1); }
console.log(`→ ${config.jev.baseUrl}/systemone · model ${config.jev.model} · scenario "${scenario}"`);

if (process.argv.includes("--raw")) {
  const t0 = performance.now();
  const res = await fetch(`${config.jev.baseUrl}/systemone`, { method: "POST", headers: { authorization: `Bearer ${config.jev.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.jev.model, state, questions: PROTOCOL }) });
  console.log(`HTTP ${res.status} in ${Math.round(performance.now() - t0)} ms`);
  console.log(await res.text());
} else {
  const holders = [{ owner: "holderA", account: "a", amountRaw: 60_000_000n }, { owner: "holderB", account: "b", amountRaw: 30_000_000n }, { owner: "holderC", account: "c", amountRaw: 10_000_000n }];
  const d = await decide(state, 1, holders);
  console.log(JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(d.brain === "jev" ? `\n✅ Jev answered in ${d.latencyMs} ms: P(burn) ${(d.probs.burn * 100).toFixed(1)}% · P(bless) ${(d.probs.bless * 100).toFixed(1)}% · P(stash) ${(d.probs.stash * 100).toFixed(1)}% → the block pulled ${d.action.toUpperCase()}` : "\n❌ Jev did not answer — the rat ran on instinct (1/3 each)");
}
process.exit(0);
