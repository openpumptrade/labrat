import { config, mode } from "./config.js";
import { sql, getMeta, setMeta } from "./db.js";
import { connection, getSolBalance, getSolUsd, getUsdPrice } from "./solana.js";
import { fetchCoinInfo, fetchTrades, creatorVaultBalancesRaw, totalSupply, tokenBalanceRaw, mintProgramId, loadCurve, resolveQuote, quoteBalance, estimateCurveBuy, toRaw, fromRaw } from "./pumpfun.js";
import { PublicKey } from "@solana/web3.js";

/// Market + pot tracker. Every POLL_SEC it refreshes the coin from pump.fun's
/// public API (price, mcap, graduation), the curve, the total supply from the
/// RPC, the unclaimed creator fees (the pot, in the coin's quote asset) and
/// the engine wallet's balances.

export const coin = {
  loaded: false, mint: "", name: "", symbol: "", image: "", description: "", creator: "", createdTs: 0, tokenProgram: "",
  quote: null,            // {mint, isSol, tokenProgram, decimals, symbol, name, image}
  taxBps: 0, isHolderReward: false,
  graduated: false, pool: "", priceUsd: 0, mcapUsd: 0, solUsd: 0, quoteUsd: 0, supply: 0, supply0: 0, burned: 0, updatedAt: 0, replyCount: 0,
};
export const pot = {
  unclaimed: 0,        // unclaimed creator fees, in the quote asset (UI units)
  unclaimedUsd: 0,
  wallet: 0,           // quote asset in the engine wallet (the lab's bank AND whatever else the owner keeps there)
  spendable: 0,        // what the next trial can spend: the lab's bank, capped by the wallet
  totalUsd: 0,         // unclaimed + spendable, in USD — "the pot" Jev is asked about
  walletSol: 0,        // SOL for fees
  walletTokens: 0,     // coin tokens in the wallet (the dev bag lives here too — the lab never touches it)
  estTokens: 0,        // what the whole pot would buy right now
  updatedAt: 0, error: null,
};
/// The lab's own books. The engine wallet is the creator wallet, so it can hold
/// the owner's SOL / quote asset / dev bag. The lab only spends what IT claimed
/// (`bankQuote`) and only burns / blesses what IT bought (`owedRaw` = bought
/// but not yet disposed of, e.g. after a failed burn).
export const ledger = { bankQuote: 0, owedRaw: 0n };
export async function saveLedger() {
  await setMeta("bank_quote", ledger.bankQuote);
  await setMeta("owed_raw", ledger.owedRaw.toString());
}

let running = false;
let walletPk = "";

export function engineWallet() { return walletPk; }

export async function loadCoin() {
  const [info, curve] = await Promise.all([fetchCoinInfo(config.mint).catch((e) => { console.warn(`[tracker] coin info unavailable (${e.message}) — booting from the curve only`); return {}; }), loadCurve(config.mint)]);
  coin.mint = config.mint;
  coin.name = info.name || "";
  coin.symbol = info.symbol || "";
  coin.image = info.image_uri || "";
  coin.description = info.description || "";
  coin.creator = curve.creator || info.creator || "";
  coin.createdTs = Number(info.created_timestamp || 0);
  coin.tokenProgram = (await mintProgramId(config.mint)).toBase58();
  coin.quote = await resolveQuote(curve.quoteMintPk);
  coin.taxBps = curve.taxBps;
  coin.isHolderReward = curve.isHolderReward;
  coin.graduated = curve.complete || Boolean(info.complete);
  coin.pool = info.pump_swap_pool || info.pool_address || "";
  coin.replyCount = Number(info.reply_count || 0);
  coin.supply = await totalSupply(config.mint);
  const s0 = Number(await getMeta("supply0", 0));
  coin.supply0 = s0 || coin.supply;
  if (!s0) await setMeta("supply0", coin.supply0);
  coin.burned = Math.max(0, coin.supply0 - coin.supply);
  coin.loaded = true;
  walletPk = mode() === "bot" ? config.wallet.publicKey.toBase58() : (config.walletAddress || coin.creator);
  if (mode() === "bot" && coin.creator && walletPk !== coin.creator) {
    console.warn(`[tracker] WARNING: WALLET_PRIVATE_KEY is ${walletPk} but pump.fun pays the creator fees of ${coin.symbol} to ${coin.creator} — claims will find nothing`);
  }
  if (coin.isHolderReward) console.warn("[tracker] WARNING: this is a holder-rewards coin — its creator fees go to holders, not to a wallet; the engine cannot claim it");
  if (!coin.quote.isSol && !coin.taxBps) console.log(`[tracker] note: ${coin.symbol} is a custom pair (${coin.quote.symbol}) without a configured tax — the standard creator fee applies`);
  return coin;
}

export async function startTracker() {
  ledger.bankQuote = Math.max(0, Number(await getMeta("bank_quote", 0)) || 0);
  ledger.owedRaw = BigInt((await getMeta("owed_raw", "0")) || "0");
  await tick();
  setInterval(tick, config.pollSec * 1000);
  console.log(`[tracker] ${coin.name} ($${coin.symbol}) · quoted in ${coin.quote.symbol} ·${coin.taxBps ? ` tax ${coin.taxBps / 100}% ·` : ""} ${coin.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL"} · ${coin.graduated ? "graduated" : "on the curve"} · supply ${coin.supply.toLocaleString()} · polling every ${config.pollSec}s`);
}

export async function readPot() {
  const q = coin.quote;
  const [vault, walletQuote, walletSol, tokensRaw] = await Promise.all([
    creatorVaultBalancesRaw(walletPk, q).catch((e) => { pot.error = String(e.message).slice(0, 120); return null; }),
    quoteBalance(walletPk, q).catch(() => pot.wallet),
    getSolBalance(walletPk).catch(() => pot.walletSol),
    mintProgramId(config.mint).then((pid) => tokenBalanceRaw(walletPk, config.mint, pid)).catch(() => 0n),
  ]);
  if (vault) { pot.unclaimed = fromRaw(vault.total, q.decimals); pot.error = null; }
  pot.unclaimedUsd = pot.unclaimed * coin.quoteUsd;
  pot.wallet = walletQuote;
  pot.walletSol = walletSol;
  const walletFree = q.isSol ? Math.max(0, walletQuote - config.rules.gasReserveSol) : walletQuote;
  pot.spendable = mode() === "bot" ? Math.min(ledger.bankQuote, walletFree) : 0;
  pot.walletTokens = Number(tokensRaw) / 1e6;
  const est = pot.unclaimed + pot.spendable;
  pot.totalUsd = est * coin.quoteUsd;
  if (est > 0) {
    try {
      const onCurve = coin.graduated ? null : await estimateCurveBuy(config.mint, q, toRaw(est, q.decimals));
      pot.estTokens = onCurve ?? (coin.priceUsd > 0 ? (est * coin.quoteUsd) / coin.priceUsd : 0);
    } catch { /* keep the previous estimate */ }
  } else pot.estTokens = 0;
  pot.updatedAt = Math.floor(Date.now() / 1000);
  return pot;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const [info, supply, solUsd, quoteUsd, curve] = await Promise.all([
      fetchCoinInfo(config.mint).catch(() => null),
      totalSupply(config.mint).catch(() => coin.supply),
      getSolUsd(),
      coin.quote.isSol ? getSolUsd() : getUsdPrice(coin.quote.mint),
      loadCurve(config.mint).catch(() => null),
    ]);
    if (info) {
      coin.mcapUsd = Number(info.usd_market_cap || 0);
      coin.priceUsd = coin.mcapUsd / 1e9; // pump.fun quotes usd_market_cap as price × the 1B mint supply, burns or not
      if (info.complete !== undefined) coin.graduated = Boolean(info.complete);
      coin.pool = info.pump_swap_pool || info.pool_address || coin.pool;
      coin.replyCount = Number(info.reply_count || coin.replyCount);
      if (info.image_uri) coin.image = info.image_uri;
    }
    if (curve) { coin.graduated = curve.complete || coin.graduated; coin.taxBps = curve.taxBps; }
    coin.supply = supply;
    coin.burned = Math.max(0, coin.supply0 - coin.supply);
    coin.solUsd = solUsd;
    coin.quoteUsd = quoteUsd;
    coin.updatedAt = Math.floor(Date.now() / 1000);
    await readPot();
    if (coin.priceUsd > 0) {
      const ts = Math.floor(Date.now() / 1000);
      await sql`insert into samples (ts, price_usd, mcap_usd, supply) values (${ts}, ${coin.priceUsd}, ${coin.mcapUsd}, ${coin.supply}) on conflict (ts) do nothing`;
      await sql`delete from samples where ts < ${ts - 14 * 86400}`;
    }
  } catch (err) {
    console.error("[tracker] tick:", String(err.message).slice(0, 200));
  } finally { running = false; }
}

/// What Jev gets to look at: the tape. Price change over 3 / 15 / 60 min from our
/// own samples, and the last interval's order flow from pump.fun's trade feed
/// (the engine's own buys are left out — it should not read its own footprints).
export async function marketReadings() {
  const ts = Math.floor(Date.now() / 1000);
  const at = async (ago) => {
    const r = await sql`select price_usd from samples where ts <= ${ts - ago} order by ts desc limit 1`;
    return r.length && r[0].price_usd > 0 && coin.priceUsd > 0 ? Number(((coin.priceUsd / r[0].price_usd - 1) * 100).toFixed(2)) : null;
  };
  const [m3, m15, h1] = await Promise.all([at(180), at(900), at(3600)]);
  const flow = { buys: 0, sells: 0, buy_usd: 0, sell_usd: 0, wallets: 0 };
  try {
    const trades = await fetchTrades(config.mint, 100);
    const seen = new Set();
    for (const t of trades) {
      const tt = Math.floor(new Date(t.timestamp ?? 0).getTime() / 1000);
      if (!(tt > ts - config.rules.intervalSec) || String(t.userAddress ?? "") === walletPk) continue;
      const buy = /buy/i.test(String(t.type ?? t.side ?? ""));
      flow[buy ? "buys" : "sells"]++;
      flow[buy ? "buy_usd" : "sell_usd"] += Number(t.amountUsd ?? 0);
      seen.add(String(t.userAddress ?? ""));
    }
    flow.wallets = seen.size;
    flow.buy_usd = Math.round(flow.buy_usd); flow.sell_usd = Math.round(flow.sell_usd);
  } catch { /* an empty tape is still a reading */ }
  return { price_change_pct: { m3, m15, h1 }, flow };
}

export { PublicKey, connection };
