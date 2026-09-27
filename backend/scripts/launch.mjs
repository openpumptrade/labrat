#!/usr/bin/env node
/// Launch $LABRAT on pump.fun: a normal coin paired with SOL (default). `--quote PUMP` makes a
/// custom-pair tax coin instead.
///
///   node scripts/launch.mjs --name LABRAT --symbol LABRAT --image public/logo.png \
///     --description "A lab rat with Jev for a brain. Every 3 min it pulls a lever: burn, bless one holder, or stash the pot." \
///     [--website https://…] [--twitter https://x.com/…] [--telegram https://t.me/…] \
///     [--dev-buy 25000] [--swap-sol 0.5] [--grind pump] [--live]
///
/// DRY RUN by default: builds create_v2 and simulates it (no keys needed — a funded public
/// wallet signs nothing). `--live` uploads the metadata to IPFS and sends the transactions with
/// WALLET_PRIVATE_KEY from .env; that wallet becomes the creator = the engine wallet.
/// `--dev-buy` is in the quote asset ($PUMP) and goes in a 2nd tx right after the create (create +
/// buy never fit one packet on a custom pair); `--swap-sol` first swaps that much SOL into $PUMP.
/// `--tax <bps>` overrides the tax (default: the on-chain max). `--quote SOL` makes a plain coin
/// (pump.fun ignores the tax on SOL/USDC pairs).
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../src/config.js";
import { connection, sendTx, LAMPORTS } from "../src/solana.js";
import { online, fetchQuoteCatalog, resolveQuote, taxConfig, buildCreate, simulateCreate, uploadIpfs, curveBuy, jupiterSwapSolTo, quoteBalance, toRaw, mintProgramId } from "../src/pumpfun.js";

const FUNDED_PUBLIC_PAYER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"; // any funded wallet works for a sigVerify-off simulation

function args() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "true";
    o[k] = v;
  }
  return o;
}

async function resolveQuoteArg(arg) {
  const want = (arg || "SOL").trim();
  if (/^(sol|wsol)$/i.test(want)) return resolveQuote(PublicKey.default);
  let pk = null;
  try { pk = new PublicKey(want); } catch { /* a ticker */ }
  if (!pk) {
    const cat = await fetchQuoteCatalog();
    const hit = [...cat.values()].find((m) => String(m.ticker).toLowerCase() === want.toLowerCase());
    if (!hit) throw new Error(`quote "${want}" is not in pump.fun's custom-pair catalog — pass SOL, a mint address or one of: ${[...cat.values()].map((m) => m.ticker).slice(0, 40).join(", ")}…`);
    pk = new PublicKey(hit.mint);
  }
  await online.resolveQuoteMint(pk); // throws when create_v2 would refuse the mint
  return resolveQuote(pk);
}

function grind(suffix) {
  const t0 = Date.now(); let n = 0;
  for (;;) {
    const kp = Keypair.generate(); n++;
    if (kp.publicKey.toBase58().endsWith(suffix)) { console.log(`   ground ${kp.publicKey.toBase58()} in ${n.toLocaleString()} tries (${((Date.now() - t0) / 1000).toFixed(0)}s)`); return kp; }
    if (n % 200_000 === 0) console.log(`   …${n.toLocaleString()} tries`);
  }
}

async function main() {
  const o = args();
  const live = o.live === "true";
  const name = o.name || "LABRAT", symbol = o.symbol || "LABRAT";
  if (symbol.length > 13) throw new Error("symbol max 13 chars (pump.fun on-chain limit)");
  const quote = await resolveQuoteArg(o.quote);
  let taxBps = 0;
  console.log(`\n$${symbol} · "${name}" · paired with ${quote.symbol}${quote.isSol ? "" : ` (${quote.mint}, ${quote.decimals} dec — custom pair)`}`);
  const gate = await taxConfig();
  const plain = quote.isSol || quote.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  console.log(`pump.fun tax gate: ${gate.enabled ? "ON" : "OFF"} · max tax ${gate.maxBps / 100}%`);
  if (plain) { if (o.tax) console.log(`note: --tax is ignored on a ${quote.symbol} pair (pump.fun only honours it on custom pairs) — standard creator fees apply`); }
  else if (!gate.enabled) console.log("note: pump.fun's tax gate is OFF — launching without a tax");
  else { taxBps = o.tax ? Number(o.tax) : gate.maxBps; if (taxBps < 1 || taxBps > gate.maxBps) throw new Error(`--tax must be 1..${gate.maxBps} bps`); console.log(`tax: ${taxBps / 100}% of every trade, paid in ${quote.symbol} → the creator = the engine wallet`); }
  if (quote.isSol) console.log("creator fees: pump.fun's standard schedule (0.30% on the curve, market-cap tiers on PumpSwap) → the creator = the engine wallet");

  const wallet = config.wallet;
  if (live && !wallet) throw new Error("--live needs WALLET_PRIVATE_KEY in backend/.env (that wallet becomes the creator = the engine wallet)");
  const payer = wallet ? wallet.publicKey : new PublicKey(FUNDED_PUBLIC_PAYER);
  console.log(`creator / engine wallet: ${payer.toBase58()}${wallet ? "" : " (public stand-in, dry run)"}`);

  const mintKp = o.grind ? (console.log(`grinding a mint ending in "${o.grind}"…`), grind(o.grind)) : Keypair.generate();
  const mint = mintKp.publicKey;

  let uri = "https://pump.fun";
  if (live || o.upload === "true") {
    const img = o.image ? path.resolve(o.image) : "";
    if (!img || !fs.existsSync(img)) throw new Error("--image <png/jpg> is required to upload the metadata");
    uri = await uploadIpfs({ name, symbol, description: o.description || "", imageBuffer: fs.readFileSync(img), imageMime: /\.jpe?g$/i.test(img) ? "image/jpeg" : "image/png", twitter: o.twitter, telegram: o.telegram, website: o.website });
    console.log(`metadata: ${uri}`);
  }

  const sim = await simulateCreate({ mint, name, symbol, uri, payer, quote, taxBps });
  console.log(`simulate create_v2: ${sim.ok ? "OK" : "FAILED"}${sim.error ? ` — ${sim.error}` : ""} · ${sim.units} CU · ${sim.bytes} bytes`);
  if (!sim.ok) { console.log(sim.logs.slice(-8).join("\n")); process.exit(1); }

  const devBuy = Number(o["dev-buy"] || 0), swapSol = Number(o["swap-sol"] || 0);
  if (devBuy > 0) console.log(`dev buy: ${devBuy} ${quote.symbol} in a 2nd tx${swapSol > 0 && !quote.isSol ? ` (after swapping ${swapSol} SOL → ${quote.symbol} on Jupiter)` : ""}`);

  if (!live) {
    console.log(`\nDRY RUN — nothing sent. Mint would be ${mint.toBase58()}. Add --live (and --image) to launch for real.`);
    return;
  }

  const sol = (await connection.getBalance(wallet.publicKey)) / LAMPORTS;
  console.log(`wallet SOL: ${sol.toFixed(4)}`);
  const need = 0.03 + (quote.isSol ? devBuy : swapSol);
  if (sol < need) throw new Error(`fund the wallet first (≥ ${need.toFixed(3)} SOL: create + fees${quote.isSol ? " + the dev buy" : " + --swap-sol"})`);

  const createIx = await buildCreate({ mint, name, symbol, uri, creator: wallet.publicKey, user: wallet.publicKey, quote, taxBps });
  const sig = await sendTx({ instructions: [createIx], payer: wallet.publicKey, signers: [wallet, mintKp], computeUnits: 400_000 });
  console.log(`\n✅ CREATED $${symbol} · CA ${mint.toBase58()} · tx ${sig}`);
  console.log(`   https://pump.fun/coin/${mint.toBase58()}`);

  if (devBuy > 0) {
    if (swapSol > 0 && !quote.isSol) {
      const { sig: s, outAmount } = await jupiterSwapSolTo({ wallet, outMint: quote.mint, lamports: BigInt(Math.floor(swapSol * LAMPORTS)) });
      console.log(`   swapped ${swapSol} SOL → ≈ ${Number(outAmount) / 10 ** quote.decimals} ${quote.symbol} · ${s}`);
    }
    const have = await quoteBalance(wallet.publicKey.toBase58(), quote);
    const amt = Math.min(devBuy, quote.isSol ? Math.max(0, have - 0.02) : have);
    if (amt <= 0) console.warn(`   ⚠ no ${quote.symbol} in the wallet for the dev buy — skipped`);
    else {
      const programId = await mintProgramId(mint.toBase58());
      const { sig: b } = await curveBuy({ wallet, mint: mint.toBase58(), quote, quoteAmountRaw: toRaw(amt, quote.decimals), programId });
      console.log(`   dev buy ${amt} ${quote.symbol} · ${b}`);
    }
  }
  console.log(`\nNow set in backend/.env (and Railway):\n   TOKEN_MINT=${mint.toBase58()}\nThe engine wallet is this wallet — its key is what claims the fees, buys and burns.`);
}

main().catch((e) => { console.error("✖", e.message); process.exit(1); });
