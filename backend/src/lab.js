import { config, mode } from "./config.js";
import { sql, getMeta, setMeta } from "./db.js";
import { getSolUsd } from "./solana.js";
import { burnAmount, blessTransfer, holderSnapshot, claimCreatorFees, curveBuy, pumpswapBuy, jupiterBuy, mintProgramId, tokenBalanceRaw, totalSupply, isGraduated, creatorVaultBalancesRaw, quoteBalance, toRaw } from "./pumpfun.js";
import { coin, pot, ledger, saveLedger, readPot, marketReadings, engineWallet } from "./tracker.js";
import { decide, ARMS } from "./jev.js";

/// The box. Every TRIAL_INTERVAL_SEC (3 minutes), on a fixed clock, ONE trial:
///   0. score the previous trials (what did the price do one interval later?)
///   1. snapshot the holders, show Jev the state of the coin and ask: which lever?
///   2. a finalized Solana block rolls Jev's odds (and, on a bless, picks the holder)
///   3. obey — BURN / BLESS: claim 100% of the creator fees → ONE market buy with the whole
///             pot → burn the tokens bought / send them all to the blessed holder
///             STASH: spend nothing, the pot rolls into the next trial
/// Every trial is logged with what Jev saw, its probabilities, its latency, the dice
/// and the receipts. If Jev cannot be asked the odds are a fair coin ("instinct") and
/// the record says so. The engine only spends what it claimed and only disposes of
/// what it bought — the owner's funds in the same wallet are never touched.

export const state = {
  nextTrialAt: 0,
  progress: null,      // the trial in flight / the last one: {status, trialId, dry, brain, action, probs, winner...}
  lastNote: null,      // {at, msg}
  lastTrial: null,
  genesis: 0,
  snapshot: null,      // the last holder snapshot: {at, holders:[{owner, amountRaw}], totalHolders, source}
  totals: { trials: 0, burns: 0, blessings: 0, stashes: 0, burned: 0, blessed: 0, spentQuote: 0, spentUsd: 0 },
  dryTotals: { trials: 0, burns: 0, blessings: 0, stashes: 0, burned: 0, blessed: 0, spentQuote: 0, spentUsd: 0 },
};

let firing = false;
const now = () => Math.floor(Date.now() / 1000);
const OPEN = ["deciding", "claiming", "buying", "dosing"];
export const isDry = () => mode() !== "bot" || config.dryRun;

/// graceful stop: a redeploy sends SIGTERM — let the trial in flight finish its txs and its bookkeeping
let stopping = false;
process.on("SIGTERM", async () => {
  stopping = true;
  for (let i = 0; i < 50 && firing; i++) await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
});

export async function startLab() {
  state.genesis = Number(await getMeta("genesis", 0));
  if (!state.genesis) { state.genesis = now(); await setMeta("genesis", state.genesis); }
  state.nextTrialAt = Number(await getMeta("next_trial_at", 0));
  const note = await getMeta("last_note");
  state.lastNote = note ? JSON.parse(note) : null;
  // a trial interrupted by a restart. If its burn / bless tx is on record it DID complete on chain — only the
  // bookkeeping was cut short. Cut before the buy: nothing was bought, the claim is in the ledger and rolls over.
  // Cut between the buy and the burn / bless: the tokens are in the ledger (`owed_raw`) and the next trial
  // disposes of them.
  await sql`update trials set status = 'done', finished_at = coalesce(finished_at, ${now()}), note = coalesce(note, 'engine update mid-trial — the receipts below are on chain') where status = any(${OPEN}) and (burn_tx is not null or bless_tx is not null)`;
  await sql`update trials set status = 'skipped', finished_at = coalesce(finished_at, ${now()}), note = 'interrupted by an engine update — the pot rolled into the next trial' where status = any(${OPEN}) and buy_tx is null`;
  await sql`update trials set status = 'done', finished_at = coalesce(finished_at, ${now()}), note = 'engine update mid-trial — the tokens bought here are disposed of by the next trial' where status = any(${OPEN}) and buy_tx is not null`;
  await loadHistory();
  if (!state.nextTrialAt || state.nextTrialAt < now() - config.rules.intervalSec) await schedule();
  refreshSnapshot().catch(() => {});
  setInterval(tick, 2_000);
  console.log(`[lab] ${mode()} mode · one trial every ${config.rules.intervalSec}s · next at ${new Date(state.nextTrialAt * 1000).toISOString()}`);
}

async function loadHistory() {
  const agg = async (dry) => {
    const [r] = await sql`select count(*)::int as n, count(*) filter (where action = 'burn')::int as burns, count(*) filter (where action = 'bless')::int as blessings, count(*) filter (where action = 'stash')::int as stashes, coalesce(sum(tokens_burned), 0) as burned, coalesce(sum(tokens_blessed), 0) as blessed, coalesce(sum(spent_quote), 0) as spent, coalesce(sum(spent_quote * coalesce(quote_usd, 0)), 0) as usd from trials where status = 'done' and dry = ${dry}`;
    return { trials: r.n, burns: r.burns, blessings: r.blessings, stashes: r.stashes, burned: Number(r.burned), blessed: Number(r.blessed), spentQuote: Number(r.spent), spentUsd: Number(r.usd) };
  };
  state.totals = await agg(false);
  state.dryTotals = await agg(true);
  const last = await sql`select * from trials where status in ('done', 'skipped', 'failed') order by id desc limit 1`;
  state.lastTrial = last.length ? rowToJson(last[0]) : null;
}

/// fixed cadence: the next trial is always genesis + k·interval, so the countdown is predictable
async function schedule() {
  const iv = config.rules.intervalSec;
  const k = Math.floor((now() - state.genesis) / iv) + 1;
  state.nextTrialAt = state.genesis + k * iv;
  await setMeta("next_trial_at", state.nextTrialAt);
}

async function tick() {
  if (firing || stopping || !coin.loaded) return;
  if (now() < state.nextTrialAt) return;
  if (!config.schedulerEnabled) { await schedule(); return; }
  firing = true;
  try { await scoreTrials(); await runTrial(); }
  catch (err) {
    const raw = String(err.message).slice(0, 160);
    console.error("[lab] trial failed:", raw);
    // the public record gets a plain sentence, the log keeps the raw error
    const rpc = /429|rate limit|fetch failed|ECONN|ETIMEDOUT|timed? ?out|blockhash|503|502/i.test(raw);
    const msg = rpc ? "the Solana RPC was busy — nothing was lost, the pot rolls into the next trial" : raw;
    if (!rpc) await note(`Trial failed: ${msg}`);
    await sql`update trials set status = 'failed', note = ${msg}, finished_at = ${now()} where status = any(${OPEN})`;
    if (state.progress) state.progress = { ...state.progress, status: "failed", note: msg, at: now() };
    await loadHistory();
  }
  finally { await schedule(); firing = false; }
}

async function note(msg) {
  state.lastNote = { at: now(), msg };
  await setMeta("last_note", JSON.stringify(state.lastNote));
}

/// the receipts: one interval after a decision, write down where the price went
async function scoreTrials() {
  if (!(coin.priceUsd > 0)) return;
  await sql`update trials set price_after = ${coin.priceUsd}, scored_at = ${now()} where price_after is null and price_usd > 0 and status = 'done' and ts <= ${now() - config.rules.intervalSec + 5}`;
}

export function rowToJson(r) {
  return {
    id: r.id, t: r.ts, status: r.status, dry: r.dry, brain: r.brain, model: r.model, latencyMs: r.latency_ms,
    action: r.action, confidence: r.confidence, probs: r.probs, readings: r.readings, state: r.state,
    potQuote: r.pot_quote, claimedQuote: r.claimed_quote, spentQuote: r.spent_quote,
    tokensBought: r.tokens_bought, tokensBurned: r.tokens_burned, tokensBlessed: r.tokens_blessed,
    winner: r.winner, winnerPct: r.winner_pct,
    quoteUsd: r.quote_usd, priceUsd: r.price_usd, priceAfter: r.price_after,
    changePct: r.price_after && r.price_usd ? (r.price_after / r.price_usd - 1) * 100 : null,
    supplyAfter: r.supply_after, venue: r.venue,
    claimTx: r.claim_tx, buyTx: r.buy_tx, burnTx: r.burn_tx, blessTx: r.bless_tx, note: r.note, finishedAt: r.finished_at,
  };
}

/// per-arm results — the experiment's running answer
export async function armStats() {
  const dry = isDry(); // once live, the dry warm-up rows stay out of the table
  const rows = await sql`select action, brain, count(*)::int as n, avg((price_after / price_usd - 1) * 100) filter (where price_after is not null and price_usd > 0) as avg_change, count(*) filter (where price_after > price_usd)::int as up, count(*) filter (where price_after is not null)::int as scored, avg(latency_ms) as avg_ms, avg((probs->>'burn')::float) as avg_pburn, coalesce(sum(tokens_burned), 0) as burned, coalesce(sum(tokens_blessed), 0) as blessed, coalesce(sum(spent_quote * coalesce(quote_usd, 0)), 0) as spent_usd from trials where status = 'done' and action is not null and dry = ${dry} group by action, brain`;
  return rows.map((r) => ({ action: r.action, brain: r.brain, n: r.n, scored: r.scored, up: r.up, avgChangePct: r.avg_change === null ? null : Number(r.avg_change), avgMs: r.avg_ms === null ? null : Math.round(Number(r.avg_ms)), avgPBurn: r.avg_pburn === null ? null : Number(r.avg_pburn), burned: Number(r.burned), blessed: Number(r.blessed), spentUsd: Number(r.spent_usd) }));
}

/// the blessed: every wallet the rat has fed
export async function blessedBoard(limit = 50) {
  const rows = await sql`select winner, count(*)::int as n, sum(tokens_blessed) as tokens, sum(spent_quote * coalesce(quote_usd, 0)) as usd, max(ts) as last from trials where status = 'done' and action = 'bless' and winner is not null and dry = ${isDry()} group by winner order by sum(tokens_blessed) desc limit ${limit}`;
  return rows.map((r) => ({ wallet: r.winner, times: r.n, tokens: Number(r.tokens), usd: Number(r.usd), last: r.last }));
}

/// who is in the draw right now — refreshed every trial (and on demand, at most once a minute)
export async function refreshSnapshot() {
  const snap = await holderSnapshot(config.mint, { exclude: [engineWallet()], limit: config.rules.blessTopN });
  state.snapshot = { at: now(), ...snap };
  return state.snapshot;
}

/// what Jev sees — small, numeric, no prose
async function buildState(holders, totalHolders) {
  const readings = await marketReadings().catch(() => ({ price_change_pct: {}, flow: {} }));
  const recent = await sql`select action, brain, price_usd, price_after from trials where status = 'done' and action is not null order by id desc limit 6`;
  const stats = await armStats();
  const arms = {};
  for (const a of ARMS) {
    const rows = stats.filter((s) => s.action === a);
    const scored = rows.reduce((n, s) => n + s.scored, 0);
    arms[a] = { trials: rows.reduce((n, s) => n + s.n, 0), avg_price_change_after_pct: scored ? Number((rows.reduce((x, s) => x + (s.avgChangePct || 0) * s.scored, 0) / scored).toFixed(2)) : null };
  }
  const inDraw = holders.reduce((acc, h) => acc + Number(h.amountRaw), 0) / 1e6;
  const top10 = holders.slice(0, 10).reduce((acc, h) => acc + Number(h.amountRaw), 0) / 1e6;
  return {
    coin: { symbol: coin.symbol, market_cap_usd: Math.round(coin.mcapUsd), venue: coin.graduated ? "pumpswap pool" : "bonding curve", supply_burned_pct: Number(((coin.supply0 ? coin.burned / coin.supply0 : 0) * 100).toFixed(3)) },
    pot: { usd: Number(pot.totalUsd.toFixed(2)), pct_of_market_cap: coin.mcapUsd > 0 ? Number(((pot.totalUsd / coin.mcapUsd) * 100).toFixed(4)) : null },
    holders: { count: totalHolders ?? holders.length, in_the_draw: holders.length, top10_pct_of_supply: coin.supply > 0 ? Number(((top10 / coin.supply) * 100).toFixed(2)) : null, draw_pct_of_supply: coin.supply > 0 ? Number(((inDraw / coin.supply) * 100).toFixed(2)) : null },
    ...readings,
    recent_trials: recent.map((r) => ({ action: r.action, by: r.brain, price_change_after_pct: r.price_after && r.price_usd ? Number(((r.price_after / r.price_usd - 1) * 100).toFixed(2)) : null })),
    results_so_far: arms,
  };
}

const setProgress = (patch) => { state.progress = { ...(state.progress || {}), ...patch, at: now() }; };
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export async function runTrial() {
  const dry = isDry();
  const q = coin.quote;
  const sym = q.symbol;
  await readPot().catch(() => {});
  const unclaimed = pot.unclaimed;
  const potTotal = unclaimed + pot.spendable;
  const quoteUsd = coin.quoteUsd;
  const ts = now();
  const [{ id }] = await sql`insert into trials (ts, status, dry, pot_quote, quote_usd, price_usd, sol_usd) values (${ts}, 'deciding', ${dry}, ${potTotal}, ${quoteUsd}, ${coin.priceUsd}, ${coin.solUsd}) returning id`;
  setProgress({ status: "deciding", trialId: id, dry, brain: null, action: null, confidence: null, probs: null, draw: null, winner: null, winnerPct: null, latencyMs: null, pot: potTotal, claimed: 0, spent: 0, bought: 0, burned: 0, blessed: 0, txs: {}, note: null });

  const finish = async (status, msg, extra = {}) => {
    await sql`update trials set status = ${status}, note = ${msg}, finished_at = ${now()} where id = ${id}`;
    setProgress({ status, note: msg, ...extra });
    await loadHistory();
    console.log(`[lab] ${status === "done" ? "✅" : "·"} trial #${id} ${status}: ${msg}`);
  };

  // a pot not worth a transaction is not worth a question either
  if (potTotal * quoteUsd < config.rules.minBuyUsd && ledger.owedRaw === 0n) {
    return finish("skipped", `pot ${fmt(potTotal)} ${sym} (~$${(potTotal * quoteUsd).toFixed(2)}) under the $${config.rules.minBuyUsd} minimum — the rat stays put, it rolls over`);
  }

  // 1. the holders are counted BEFORE the dice exist, then the question, then the block
  const snap = await refreshSnapshot().catch((err) => { console.warn(`[lab] holder snapshot failed: ${String(err.message).slice(0, 80)}`); return { holders: [], totalHolders: null, source: "unavailable" }; });
  const seen = await buildState(snap.holders, snap.totalHolders);
  const d = await decide(seen, id, snap.holders);
  if (d.readings?.bless) { d.readings.bless.source = snap.source; d.readings.bless.totalHolders = snap.totalHolders; }
  await sql`update trials set brain = ${d.brain}, model = ${d.model}, latency_ms = ${d.latencyMs}, action = ${d.action}, confidence = ${d.confidence}, probs = ${sql.json(d.probs)}, readings = ${sql.json(d.readings || {})}, state = ${sql.json(seen)}, winner = ${d.winner?.owner || null}, winner_pct = ${d.winner?.pct ?? null} where id = ${id}`;
  setProgress({ brain: d.brain, action: d.action, confidence: d.confidence, probs: d.probs, latencyMs: d.latencyMs, draw: d.readings?.draw ? { ticket: d.readings.draw.ticket, burnLine: d.readings.draw.burnLine, of: d.readings.draw.of, slot: d.readings.seed?.slot } : null, winner: d.winner?.owner || null, winnerPct: d.winner?.pct ?? null });
  const who = d.brain === "jev" ? "Jev" : "instinct";
  const odds = `${who} ${Math.round(d.probs.burn * 100)}/${Math.round(d.probs.bless * 100)}/${Math.round((d.probs.stash || 0) * 100)}`;
  console.log(`[lab] 🐀 trial #${id} · pot ${fmt(potTotal)} ${sym} · ${odds}${d.latencyMs ? ` (${d.latencyMs} ms)` : ""} → ${d.action.toUpperCase()}${d.winner ? ` ${d.winner.owner} (${d.winner.pct.toFixed(2)}% odds)` : ""}${dry ? " · DRY" : ""}`);
  const why = d.note ? ` · ${d.note}` : "";
  const blessLine = (n) => `blessed ${short(d.winner.owner)} with ${Math.round(n).toLocaleString()} $${coin.symbol} (their odds: ${d.winner.pct.toFixed(2)}%)`;

  // STASH — the rat keeps the pot. Nothing is claimed, nothing is bought; the next lever pull is bigger.
  if (d.action === "stash") {
    await sql`update trials set claimed_quote = 0, spent_quote = 0, tokens_bought = 0, tokens_burned = 0, tokens_blessed = 0 where id = ${id}`;
    return finish("done", `${odds} → STASH · the rat keeps the pot: ${fmt(potTotal)} ${sym} (~$${(potTotal * quoteUsd).toFixed(2)}) rolls into the next trial${why}`, { claimed: 0, spent: 0, bought: 0, burned: 0, blessed: 0 });
  }

  if (dry) {
    const est = pot.estTokens || (coin.priceUsd > 0 && quoteUsd > 0 ? (potTotal * quoteUsd) / coin.priceUsd : 0);
    const msg = `${odds} → ${d.action.toUpperCase()} · would claim ${fmt(unclaimed)} ${sym}, buy ≈ ${Math.round(est).toLocaleString()} $${coin.symbol} and ${d.action === "burn" ? "burn them" : `send them to ${short(d.winner.owner)} (their odds: ${d.winner.pct.toFixed(2)}%)`}${why}`;
    await sql`update trials set claimed_quote = ${unclaimed}, spent_quote = ${potTotal}, tokens_bought = ${est}, tokens_burned = ${d.action === "burn" ? est : 0}, tokens_blessed = ${d.action === "bless" ? est : 0}, venue = ${coin.graduated ? "pumpswap" : "curve"} where id = ${id}`;
    return finish("done", msg, { claimed: unclaimed, spent: potTotal, bought: est, burned: d.action === "burn" ? est : 0, blessed: d.action === "bless" ? est : 0 });
  }

  const wallet = config.wallet;
  const me = wallet.publicKey.toBase58();
  const programId = await mintProgramId(config.mint);
  const txs = {};

  // the engine needs SOL for fees, whatever the coin is quoted in
  if (pot.walletSol < config.rules.minGasSol) {
    const msg = `engine wallet has ${pot.walletSol.toFixed(4)} SOL — needs at least ${config.rules.minGasSol} SOL for fees. Top it up.`;
    await note(msg);
    return finish("failed", msg);
  }

  // 2. claim — everything pump.fun owes the creator (curve vault + PumpSwap vault), in the quote asset
  setProgress({ status: "claiming" });
  await sql`update trials set status = 'claiming' where id = ${id}`;
  let claimed = 0;
  if (unclaimed * quoteUsd >= config.rules.minClaimUsd) {
    const claimable = await creatorVaultBalancesRaw(me, q);
    const before = await quoteBalance(me, q);
    const { sig } = await claimCreatorFees(wallet, q, claimable);
    if (sig) {
      txs.claim = sig;
      const after = await quoteBalance(me, q);
      // SOL quote: the claim tx fee comes out of the same balance — never book less than zero
      claimed = Math.max(0, after - before);
      ledger.bankQuote += claimed; await saveLedger();
      console.log(`[lab] claimed ${fmt(claimed)} ${sym} · ${sig}`);
    }
  }
  const walletQuote = await quoteBalance(me, q);
  const walletFree = q.isSol ? Math.max(0, walletQuote - config.rules.gasReserveSol) : walletQuote;
  const spend = Math.min(ledger.bankQuote, walletFree);
  await sql`update trials set claimed_quote = ${claimed}, claim_tx = ${txs.claim || null}, status = 'buying' where id = ${id}`;
  setProgress({ status: "buying", claimed, txs: { ...txs } });

  // 3. ONE buy with the whole pot
  let buyTx = "", venue = "";
  const tokensBefore = await tokenBalanceRaw(me, config.mint, programId);
  // the engine can never owe more than the wallet holds — heals a ledger left stale by a crash mid-trial
  if (ledger.owedRaw > tokensBefore) { console.warn(`[lab] ledger owed ${ledger.owedRaw} > wallet ${tokensBefore} — clamped`); ledger.owedRaw = tokensBefore; await saveLedger(); }
  if (spend * quoteUsd >= config.rules.minBuyUsd) {
    const raw = toRaw(spend, q.decimals);
    const graduated = (await isGraduated(config.mint)) ?? coin.graduated;
    const poolBuy = async () => {
      try { venue = "pumpswap"; return await pumpswapBuy({ wallet, mint: config.mint, quote: q, quoteAmountRaw: raw, pool: coin.pool }); }
      catch (err) { console.warn(`[lab] PumpSwap buy failed (${String(err.message).slice(0, 100)}) — routing through Jupiter`); venue = "jupiter"; return jupiterBuy({ wallet, mint: config.mint, quote: q, quoteAmountRaw: raw }); }
    };
    try {
      if (graduated) ({ sig: buyTx } = await poolBuy());
      else { venue = "curve"; ({ sig: buyTx } = await curveBuy({ wallet, mint: config.mint, quote: q, quoteAmountRaw: raw, programId })); }
    } catch (err) {
      if (!graduated && /graduated|complete|6002|BondingCurveComplete/i.test(String(err.message))) {
        console.warn("[lab] curve buy refused — the coin graduated, buying on PumpSwap");
        ({ sig: buyTx } = await poolBuy());
      } else throw err;
    }
    txs.buy = buyTx;
  }
  // what the buy brought in — the ONLY tokens this trial may dispose of (plus what earlier trials still owe)
  let boughtRaw = 0n, spent = 0;
  if (buyTx) {
    for (let i = 0; i < 5 && boughtRaw === 0n; i++) {
      await new Promise((r) => setTimeout(r, 1500)); // let the RPC catch up with the buy
      const after = await tokenBalanceRaw(me, config.mint, programId);
      boughtRaw = after > tokensBefore ? after - tokensBefore : 0n;
    }
    const walletAfterBuy = await quoteBalance(me, q);
    spent = Math.min(ledger.bankQuote, Math.max(0, walletQuote - walletAfterBuy));
    ledger.bankQuote = Math.max(0, ledger.bankQuote - spent);
    ledger.owedRaw += boughtRaw; await saveLedger();
    console.log(`[lab] bought ${(Number(boughtRaw) / 1e6).toLocaleString()} $${coin.symbol} with ${fmt(spent)} ${sym} on ${venue} · ${buyTx}`);
  }
  await sql`update trials set spent_quote = ${spent}, tokens_bought = ${Number(boughtRaw) / 1e6}, buy_tx = ${buyTx || null}, venue = ${venue || null}, status = 'dosing' where id = ${id}`;
  setProgress({ status: "dosing", spent, bought: Number(boughtRaw) / 1e6, txs: { ...txs } });

  // 4. dispose of what the engine holds: burn it, or send it all to the blessed holder
  const balance = await tokenBalanceRaw(me, config.mint, programId);
  let todo = ledger.owedRaw < balance ? ledger.owedRaw : balance;
  let burned = 0, blessed = 0, fellBack = "";
  if (todo > 0n && d.action === "bless") {
    try {
      const { sig, amount } = await blessTransfer({ wallet, mint: config.mint, programId, amountRaw: todo, account: d.winner.account });
      txs.bless = sig; blessed = Number(amount) / 1e6;
      ledger.owedRaw -= amount; todo -= amount; await saveLedger();
      console.log(`[lab] 😇 blessed ${d.winner.owner} with ${blessed.toLocaleString()} $${coin.symbol} · ${sig}`);
    } catch (err) {
      // the winner closed or emptied their account between the snapshot and the transfer
      fellBack = "the blessed wallet could not receive";
      console.warn(`[lab] bless failed (${String(err.message).slice(0, 120)}) — burning instead`);
    }
  }
  if (todo > 0n && (d.action === "burn" || fellBack)) {
    const { sig, amount } = await burnAmount({ wallet, mint: config.mint, programId, amountRaw: todo });
    txs.burn = sig; burned = Number(amount) / 1e6;
    ledger.owedRaw -= amount; await saveLedger();
    console.log(`[lab] 🔥 burned ${burned.toLocaleString()} $${coin.symbol} · ${sig}`);
  }

  const supplyAfter = await totalSupply(config.mint).catch(() => null);
  const solUsd = await getSolUsd();
  const acted = Boolean(buyTx) || burned > 0 || blessed > 0;
  const msg = acted
    ? `${odds} → ${d.action.toUpperCase()} · claimed ${fmt(claimed)} ${sym} · bought with ${fmt(spent)} ${sym} on ${venue || "—"}${blessed ? ` · ${blessLine(blessed)}` : ""}${burned ? ` · burned ${Math.round(burned).toLocaleString()} $${coin.symbol}` : ""}${fellBack ? ` · ${fellBack} → burned instead` : ""}${why}`
    : `${odds} → ${d.action.toUpperCase()} · the pot (${fmt(spend)} ${sym}, ~$${(spend * quoteUsd).toFixed(2)}) is under the $${config.rules.minBuyUsd} minimum, it rolls over${why}`;
  await sql`update trials set tokens_burned = ${burned}, tokens_blessed = ${blessed}, burn_tx = ${txs.burn || null}, bless_tx = ${txs.bless || null}, supply_after = ${supplyAfter}, sol_usd = ${solUsd} where id = ${id}`;
  if (state.lastNote) { state.lastNote = null; await setMeta("last_note", ""); } // a clean trial clears the last error note
  if (supplyAfter !== null) { coin.supply = supplyAfter; coin.burned = Math.max(0, coin.supply0 - supplyAfter); }
  await readPot().catch(() => {});
  return finish(acted ? "done" : "skipped", msg, { burned, blessed, txs: { ...txs } });
}

function fmt(v) {
  const n = Number(v) || 0;
  return n >= 100 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(2) : n.toPrecision(3);
}
