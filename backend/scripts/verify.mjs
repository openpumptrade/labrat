#!/usr/bin/env node
/// Free on-chain check of the engine's transaction paths for TOKEN_MINT — no keys, nothing sent.
/// Simulates (sigVerify off, from the coin's creator) the claim of the tax and a small buy_v2.
import { PublicKey } from "@solana/web3.js";
import { config } from "../src/config.js";
import { simulate } from "../src/solana.js";
import { online, sdk, loadCurve, resolveQuote, creatorVaultBalancesRaw, claimInstructions, pumpGlobals, mintProgramId, quoteBalance, toRaw, BN, getBuyTokenAmountFromSolAmount } from "../src/pumpfun.js";

const mint = process.argv[2] || config.mint;
if (!mint) { console.error("usage: node scripts/verify.mjs <mint>  (or TOKEN_MINT in .env)"); process.exit(1); }
const curve = await loadCurve(mint);
const quote = await resolveQuote(curve.quoteMintPk);
const creator = new PublicKey(curve.creator);
console.log(`${mint} · quoted in ${quote.symbol} · tax ${curve.taxBps / 100}% · creator ${creator.toBase58()} · ${curve.complete ? "graduated" : "on the curve"}`);
const claimable = await creatorVaultBalancesRaw(creator.toBase58(), quote);
console.log(`unclaimed creator fees: curve ${claimable.bonding} + pumpswap ${claimable.amm} raw ${quote.symbol}`);
const cl = await claimInstructions(creator, quote, claimable);
const s1 = await simulate({ instructions: cl, payer: creator, computeUnits: 200_000 });
console.log(`claim (${cl.length} ixs): ${s1.ok ? "OK" : "FAIL — " + s1.error} · ${s1.units} CU`);
if (!s1.ok) console.log(s1.logs.slice(-6).join("\n"));
if (!curve.complete) {
  const have = await quoteBalance(creator.toBase58(), quote);
  const amt = Math.min(have * 0.5, quote.isSol ? 0.001 : have * 0.5);
  if (amt <= 0) console.log(`buy_v2: creator holds no ${quote.symbol} — skipped`);
  else {
    const programId = await mintProgramId(mint);
    const { global, feeConfig } = await pumpGlobals();
    const st = await online.fetchBuyState(new PublicKey(mint), creator, programId, quote.isSol ? undefined : new PublicKey(quote.mint));
    const quoteAmount = new BN(toRaw(amt, quote.decimals).toString());
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: quoteAmount, quoteMint: st.quoteMint });
    const common = { global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: new PublicKey(mint), user: creator, amount, slippage: 5, tokenProgram: programId };
    const ixs = quote.isSol ? await sdk.buyInstructions({ ...common, solAmount: quoteAmount }) : await sdk.buyV2Instructions({ ...common, quoteAmount, quoteTokenProgram: quote.tokenProgram });
    const s2 = await simulate({ instructions: ixs, payer: creator, computeUnits: 400_000 });
    console.log(`buy ${amt} ${quote.symbol} → ≈ ${(Number(amount.toString()) / 1e6).toLocaleString()} tokens: ${s2.ok ? "OK" : "FAIL — " + s2.error} · ${s2.units} CU`);
    if (!s2.ok) console.log(s2.logs.slice(-8).join("\n"));
  }
}
process.exit(0);
