import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/// LABRAT engine config. One engine per coin. Every TRIAL_INTERVAL_SEC the engine
/// shows Jev (TypeSafe AI's System One model — the rat's brain) the state of the coin
/// and asks ONE typed question: which lever? BURN, BLESS or STASH. Jev answers in
/// milliseconds with calibrated probabilities, a Solana block rolls those odds, and the
/// engine obeys — claim the creator fees, one market buy, then burn the tokens, send
/// them all to one holder drawn with odds proportional to their share of the supply,
/// or stash the whole pot for the next trial (no buy: the next lever pull is bigger).
/// $LABRAT is a normal pump.fun coin paired with SOL: the pot is the standard creator
/// fees, in SOL. (The engine also runs a custom pair carrying its own tax.)

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : String(v).toLowerCase() === "true");

/// bs58 (Phantom/Solflare export) or a JSON byte array. Anything else (for
/// example the PASTE_PRIVATE_KEY_HERE placeholder) keeps the engine in watch mode.
export function parseKeypair(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
    const bytes = bs58.decode(s);
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch { return null; }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/labrat",
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  brand: {
    name: process.env.BRAND_NAME || "LABRAT",
    siteUrl: (process.env.SITE_URL || "http://localhost:4000").replace(/\/$/, ""),
    twitter: process.env.BRAND_TWITTER || "",
    telegram: process.env.BRAND_TELEGRAM || "",
  },

  // the coin — one engine per mint
  mint: (process.env.TOKEN_MINT || "").trim(),
  // shown on the page before the coin exists (the real rate is read from the curve once live)
  plannedTaxBps: num(process.env.TAX_BPS, 0),

  // the creator wallet of the coin (the one pump.fun pays the creator fees to).
  // With its key the engine claims + buys + burns/blesses ("bot" mode); without
  // it the engine only watches the pot and records dry trials ("watch" mode).
  wallet: parseKeypair(process.env.WALLET_PRIVATE_KEY),
  // watch mode only: read the pot of this address instead of the coin's creator
  walletAddress: (process.env.WALLET_ADDRESS || "").trim(),
  dryRun: bool(process.env.DRY_RUN, false),
  // master kill switch — API and page stay up, nothing moves
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),

  rules: {
    intervalSec: num(process.env.TRIAL_INTERVAL_SEC, 180),   // one trial every 3 minutes
    // thresholds in USD so the same engine works whatever the coin is quoted in (SOL, or a custom pair)
    minClaimUsd: num(process.env.MIN_CLAIM_USD, 0.1),        // don't bother claiming dust
    minBuyUsd: num(process.env.MIN_BUY_USD, 0.25),           // a pot smaller than this is not worth a question — it rolls over
    gasReserveSol: num(process.env.GAS_RESERVE_SOL, 0.01),   // SOL kept for tx fees (only spent on buys when the quote IS SOL)
    minGasSol: num(process.env.MIN_GAS_SOL, 0.003),          // below this the engine refuses to fire (token-quoted coins need SOL for fees)
    slippagePct: num(process.env.SLIPPAGE_PCT, 5),
    blessTopN: Math.max(1, Math.min(250, num(process.env.BLESS_TOP_N, 100))), // the N largest real wallets are in the draw
  },

  // the brain — TypeSafe AI's System One model. Without a key the odds are a fair
  // coin (50 / 50, "instinct") and every trial is labelled as such on the page.
  jev: {
    apiKey: (process.env.TYPESAFE_API_KEY || "").trim(),
    baseUrl: (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1").replace(/\/$/, ""),
    model: process.env.JEV_MODEL || "jev-latest",
    timeoutMs: num(process.env.JEV_TIMEOUT_MS, 5000),
  },
  pollSec: num(process.env.POLL_SEC, 10),
  priorityMicroLamports: num(process.env.PRIORITY_MICRO_LAMPORTS, 100_000),
};

export const mode = () => (config.wallet ? "bot" : "watch");

if (!config.mint) console.warn("[config] TOKEN_MINT not set — the page runs in 'not started' mode");
if (!config.wallet) console.warn(`[config] WALLET_PRIVATE_KEY ${(process.env.WALLET_PRIVATE_KEY || "").trim() ? "is not a valid key" : "not set"} — watch mode: dry trials, nothing moves`);
if (!config.jev.apiKey) console.warn("[config] TYPESAFE_API_KEY not set — Jev is offline, the rat runs on instinct (equal odds on every lever)");
if (!config.schedulerEnabled) console.warn("[config] SCHEDULER_ENABLED=false — kill switch ON: no questions, no claims, no buys");
