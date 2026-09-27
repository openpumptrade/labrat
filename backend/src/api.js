import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { config, mode } from "./config.js";
import { sql } from "./db.js";
import { coin, pot, ledger, engineWallet } from "./tracker.js";
import { state, rowToJson, armStats, blessedBoard, refreshSnapshot, isDry } from "./lab.js";
import { PROTOCOL, ARMS, LINE, INSTINCT, jevOnline } from "./jev.js";
import { fetchCandles, fetchTrades, taxConfig } from "./pumpfun.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const now = () => Math.floor(Date.now() / 1000);
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { v, at: Date.now() });
  return v;
}

export function startApi(started) {
  const app = express();
  app.use(cors());
  app.set("etag", false);
  app.use("/api", (_req, res, next) => { res.set("cache-control", "no-store"); next(); });

  app.get("/api/health", (_req, res) => res.json({ ok: true, mode: mode(), scheduler: config.schedulerEnabled, started, coin: coin.symbol, quote: coin.quote?.symbol || null, taxBps: coin.taxBps, jev: jevOnline(), nextTrialAt: state.nextTrialAt }));

  /// the exact words Jev is asked, every trial — immutable, public — and how the dice work
  app.get("/api/protocol", (_req, res) => res.json({
    model: config.jev.model, online: jevOnline(), endpoint: `${config.jev.baseUrl}/systemone`, questions: PROTOCOL, arms: ARMS,
    odds: { jev: "P(burn), P(bless) and P(stash) exactly as the model answers them", instinct: "no model connected or reachable: equal odds on every lever (1/3 each) — labelled `instinct`, never `jev`" },
    dice: {
      seed: "blockhash of the newest FINALIZED Solana block, read after the model answered and after the holders were counted",
      arm: `ticket = int(sha256(blockhash + ':' + trialId + ':arm').slice(0, 8), 16) % ${LINE} — burn if ticket < round(P(burn) * ${LINE}); bless if ticket < round(P(burn) * ${LINE}) + round(P(bless) * ${LINE}); stash otherwise`,
      holder: "ticket = int(sha256(blockhash + ':' + trialId + ':bless').slice(0, 16), 16) % sum(balances) — the winner is the holder whose slice of the cumulative balances (snapshot order) contains the ticket",
      snapshot: `the ${config.rules.blessTopN} largest real wallets (program-owned accounts and the engine wallet excluded), stored with the trial`,
    },
  }));

  app.get("/api/token", async (_req, res) => {
    if (!started) {
      const tax = await cached("taxcfg", 60_000, () => taxConfig()).catch(() => null);
      return res.json({ started: false, jev: { online: jevOnline(), model: config.jev.model }, brand: config.brand, rules: config.rules, chain: "Solana", launchpad: "pump.fun", plannedTaxBps: config.plannedTaxBps, taxGate: tax, now: now() });
    }
    res.json({
      started: true, mode: mode(), jev: { online: jevOnline(), model: config.jev.model }, brand: config.brand, rules: config.rules,
      dryRun: config.dryRun || mode() !== "bot", schedulerEnabled: config.schedulerEnabled,
      chain: "Solana", launchpad: "pump.fun",
      mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image, creator: coin.creator, wallet: engineWallet(),
      quote: coin.quote, taxBps: coin.taxBps, isHolderReward: coin.isHolderReward,
      tokenProgram: coin.tokenProgram, graduated: coin.graduated, pool: coin.pool, createdTs: coin.createdTs,
      priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd, realMcapUsd: coin.priceUsd * coin.supply, solUsd: coin.solUsd, quoteUsd: coin.quoteUsd,
      supply: coin.supply, supply0: coin.supply0, burned: coin.burned,
      burnedPct: coin.supply0 ? coin.burned / coin.supply0 : 0, marketUpdatedAt: coin.updatedAt,
      pot: { unclaimed: pot.unclaimed, unclaimedUsd: pot.unclaimedUsd, bank: ledger.bankQuote, spendable: pot.spendable, total: pot.unclaimed + pot.spendable, totalUsd: pot.totalUsd, walletSol: pot.walletSol, owedTokens: Number(ledger.owedRaw) / 1e6, estTokens: pot.estTokens, updatedAt: pot.updatedAt, error: pot.error },
      nextTrialAt: state.nextTrialAt, genesis: state.genesis, progress: state.progress, lastNote: state.lastNote,
      totals: state.totals, dryTotals: state.dryTotals, lastTrial: state.lastTrial,
      links: { pump: `https://pump.fun/coin/${coin.mint}`, explorer: `https://solscan.io/token/${coin.mint}`, wallet: `https://solscan.io/account/${engineWallet()}`, tx: "https://solscan.io/tx/", quote: coin.quote?.isSol ? "" : `https://solscan.io/token/${coin.quote.mint}` },
      now: now(),
    });
  });

  app.get("/api/trials", async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit || 60));
    const rows = await sql`select * from trials where status in ('done', 'skipped', 'failed') order by id desc limit ${limit}`;
    // the holder snapshot is heavy — the list carries its size, /api/trials/:id carries the whole thing
    res.json(rows.map(rowToJson).map((t) => (t.readings?.bless?.holders ? { ...t, state: undefined, readings: { ...t.readings, bless: { ...t.readings.bless, holders: undefined, holdersInDraw: t.readings.bless.holders.length } } } : { ...t, state: undefined })));
  });
  app.get("/api/trials/:id", async (req, res) => {
    const rows = await sql`select * from trials where id = ${Number(req.params.id) || 0}`;
    if (!rows.length) return res.status(404).json({ error: "no such trial" });
    res.json(rowToJson(rows[0]));
  });

  /// every wallet the rat has fed
  app.get("/api/blessed", async (_req, res) => res.json(await cached("blessed", 5_000, () => blessedBoard(50))));

  /// who is in the draw right now, and with what odds. ?wallet= adds that wallet's line.
  app.get("/api/odds", async (req, res) => {
    if (!started) return res.json({ started: false, holders: [] });
    const snap = await cached("snap", 60_000, async () => (state.snapshot && now() - state.snapshot.at < 200 ? state.snapshot : refreshSnapshot())).catch(() => state.snapshot);
    if (!snap) return res.json({ started: true, holders: [], error: "holder list unavailable right now" });
    const total = snap.holders.reduce((acc, h) => acc + Number(h.amountRaw), 0);
    const line = (h, i) => ({ rank: i + 1, wallet: h.owner, tokens: Number(h.amountRaw) / 1e6, oddsPct: total ? (Number(h.amountRaw) / total) * 100 : 0 });
    const wallet = String(req.query.wallet || "").trim();
    const idx = wallet ? snap.holders.findIndex((h) => h.owner === wallet) : -1;
    const [pb] = await sql`select avg((probs->>'bless')::float) as p from (select probs from trials where status = 'done' and probs is not null and dry = ${isDry()} order by id desc limit 40) t`;
    res.json({ started: true, at: snap.at, source: snap.source, totalHolders: snap.totalHolders, inDraw: snap.holders.length, limit: config.rules.blessTopN, tokensInDraw: total / 1e6,
      avgPBless: pb?.p === null || pb?.p === undefined ? null : Number(pb.p), trialsPerDay: Math.round(86400 / config.rules.intervalSec),
      holders: snap.holders.slice(0, 25).map(line), you: wallet ? (idx >= 0 ? line(snap.holders[idx], idx) : { wallet, rank: null, tokens: 0, oddsPct: 0 }) : null });
  });

  /// the experiment's running answer: per arm (and per brain), what the price did one interval later
  app.get("/api/results", async (_req, res) => res.json(await cached("results", 5_000, armStats)));

  /// price history for the chart: pump.fun candles (USD) + our own samples as fallback
  app.get("/api/chart", async (req, res) => {
    if (!started) return res.status(404).json({ error: "not started" });
    const interval = ["1m", "5m", "15m", "1h"].includes(String(req.query.i)) ? String(req.query.i) : "1m";
    const trials = (await sql`select id, ts, dry, action, brain, spent_quote, quote_usd from trials where status = 'done' and action is not null order by id desc limit 400`).reverse().map((b) => ({ id: b.id, t: b.ts, dry: b.dry, action: b.action, brain: b.brain, spentUsd: b.spent_quote * (b.quote_usd || 0) }));
    try {
      const candles = await cached(`c:${interval}`, 8_000, () => fetchCandles(coin.mint, interval, coin.createdTs, 1000));
      const points = candles.map((c) => ({ t: Number(c.timestamp ?? c.time ?? c.t), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close), v: Number(c.volume ?? 0) }))
        .filter((c) => isFinite(c.t) && c.c > 0).map((c) => (c.t > 1e12 ? { ...c, t: Math.floor(c.t / 1000) } : c)).sort((a, b) => a.t - b.t);
      res.json({ source: "pump.fun", interval, points, trials, priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd, supply0: coin.supply0, supply: coin.supply, now: now() });
    } catch (err) {
      const rows = await sql`select ts, price_usd from samples order by ts`;
      res.json({ source: "samples", interval, points: rows.map((r) => ({ t: r.ts, c: r.price_usd, o: r.price_usd, h: r.price_usd, l: r.price_usd, v: 0 })), trials, priceUsd: coin.priceUsd, mcapUsd: coin.mcapUsd, supply0: coin.supply0, supply: coin.supply, now: now(), error: String(err.message).slice(0, 100) });
    }
  });

  app.get("/api/trades", async (_req, res) => {
    if (!started) return res.json([]);
    try {
      const trades = await cached("trades", 5_000, () => fetchTrades(coin.mint, 40));
      const me = engineWallet();
      // swap-api shape: {tx, timestamp (ISO), userAddress, type: "buy"|"sell", amountSol, amountUsd, baseAmount, quoteAmount, priceUsd}
      res.json(trades.map((t) => ({
        t: Math.floor(new Date(t.timestamp ?? 0).getTime() / 1000) || Math.floor(Number(t.timestamp ?? 0) / 1000),
        side: /buy/i.test(String(t.type ?? t.side ?? "")) || t.is_buy === true ? "buy" : "sell",
        quote: Number(t.quoteAmount ?? (coin.quote?.isSol ? t.amountSol : 0) ?? 0),
        sol: Number(t.amountSol ?? 0),
        tokens: Number(t.baseAmount ?? t.token_amount ?? 0),
        usd: Number(t.amountUsd ?? 0), priceUsd: Number(t.priceUsd ?? 0),
        wallet: String(t.userAddress ?? t.user ?? ""), tx: String(t.tx ?? t.signature ?? ""),
        engine: String(t.userAddress ?? "") === me,
      })).filter((t) => t.t > 0));
    } catch (err) { res.json([]); }
  });

  app.use(express.static(path.join(here, "..", "public"), { etag: false, maxAge: 0 }));
  app.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}
