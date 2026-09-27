import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { config } from "./config.js";

/// Every RPC call goes through one polite queue: spaced out (public RPCs cap requests per IP, and a
/// cloud host shares its IP with strangers) and retried with backoff on 429 / 5xx / network errors,
/// so a busy minute at the RPC does not fail a trial.
const RPC_GAP_MS = Number(process.env.RPC_GAP_MS || 120);
let rpcChain = Promise.resolve();
async function politeFetch(url, init) {
  const turn = rpcChain.then(() => new Promise((r) => setTimeout(r, RPC_GAP_MS)));
  rpcChain = turn.catch(() => {});
  await turn;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < 7) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
      return res;
    } catch (err) {
      if (attempt >= 7) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

export const connection = new Connection(config.rpcUrl, { commitment: "confirmed", fetch: politeFetch, disableRetryOnRateLimit: true });
export const LAMPORTS = LAMPORTS_PER_SOL;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/// Builds, signs, simulates and sends a v0 transaction with priority fees.
/// Returns the signature after 'confirmed'.
export async function sendTx({ instructions, payer, signers, computeUnits = 300_000, skipSimulation = false }) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityMicroLamports }),
    ...instructions,
  ];
  // a public RPC behind a load balancer can simulate on a node that has not seen the
  // blockhash yet ("BlockhashNotFound") — retry with a fresh one instead of failing the blast
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign(signers);
    if (!skipSimulation) {
      const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
      if (sim.value.err) {
        const err = JSON.stringify(sim.value.err);
        if (/BlockhashNotFound/i.test(err) && attempt < 4) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        const logs = (sim.value.logs || []).slice(-6).join("\n");
        throw new Error(`simulation failed: ${err}\n${logs}`);
      }
    }
    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) {
      // landed on chain but failed (slippage, state changed since the simulation…) — the caller must know
      const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      const logs = (t?.meta?.logMessages || []).filter((l) => /Error|failed/i.test(l)).slice(-3).join(" | ");
      throw new Error(`tx ${sig} failed on chain: ${JSON.stringify(conf.value.err)} ${logs}`);
    }
    return sig;
  }
}

/// Free simulation of unsigned instructions from any (funded) payer — no keys needed.
export async function simulate({ instructions, payer, computeUnits = 400_000 }) {
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: "11111111111111111111111111111111", instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...instructions] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const logs = sim.value.logs || [];
  const reason = logs.find((l) => /Error Message/.test(l))?.replace(/.*Error Message: /, "") || (sim.value.err ? JSON.stringify(sim.value.err) : "");
  return { ok: !sim.value.err, error: reason, units: sim.value.unitsConsumed, logs, bytes: tx.serialize().length };
}

/// A public random beacon: the newest FINALIZED Solana block. Nobody — the lab included — knows
/// its blockhash in advance, and anyone can look the slot up afterwards. Skipped slots have no
/// block, so walk back a few.
export async function randomBeacon() {
  const tip = await connection.getSlot("finalized");
  for (let slot = tip; slot > tip - 8; slot--) {
    try {
      const block = await connection.getBlock(slot, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 });
      if (block?.blockhash) return { slot, blockhash: block.blockhash };
    } catch { /* skipped slot / pruned — try the one before */ }
  }
  throw new Error("no finalized block available");
}

export async function getSolBalance(pubkey) {
  return (await connection.getBalance(new PublicKey(pubkey))) / LAMPORTS_PER_SOL;
}

// ------------------------------------------------------------- USD prices
const priceCache = new Map(); // mint → {price, ts}
/// USD price of any mint via Jupiter (SOL = WSOL), 30 s cache, CoinGecko fallback for SOL.
export async function getUsdPrice(mint) {
  const key = String(mint);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.ts < 30_000 && hit.price > 0) return hit.price;
  let price = 0;
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${key}`, { signal: AbortSignal.timeout(8_000) });
    const json = await res.json();
    price = Number(json?.[key]?.usdPrice ?? json?.data?.[key]?.price);
  } catch { /* fall through */ }
  if (!(isFinite(price) && price > 0) && key === WSOL_MINT) {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8_000) });
      price = Number((await res.json())?.solana?.usd);
    } catch { /* stale */ }
  }
  if (isFinite(price) && price > 0) priceCache.set(key, { price, ts: Date.now() });
  return priceCache.get(key)?.price || 0;
}
export const getSolUsd = () => getUsdPrice(WSOL_MINT);
