import { config, mode } from "./config.js";
import { ensureSchema, acquireEngineLock } from "./db.js";
import { loadCoin, startTracker } from "./tracker.js";
import { startLab } from "./lab.js";
import { startApi } from "./api.js";

/// LABRAT. Every 3 minutes the rat's brain (Jev) is asked one question — which lever: burn, bless or stash? —
/// a Solana block rolls its odds and the engine obeys. One process: market/pot tracker + lab + API + page.

async function main() {
  await ensureSchema();
  if (!config.mint) {
    startApi(false);
    console.log("[boot] no TOKEN_MINT — serving the page in 'not started' mode");
    return;
  }
  const coin = await loadCoin();
  console.log(`[boot] ${coin.name} ($${coin.symbol}) · mint ${coin.mint} · paired with ${coin.quote.symbol}${coin.taxBps ? ` · tax ${coin.taxBps / 100}%` : ""} · creator ${coin.creator} · mode ${mode()} · dryRun ${config.dryRun} · scheduler ${config.schedulerEnabled} · jev ${config.jev.apiKey ? config.jev.model : "OFFLINE (instinct, 50/50)"}`);
  startApi(true);
  await acquireEngineLock(); // before the ledger is read — never two engines on one wallet
  await startTracker();
  await startLab();
}

main().catch((err) => { console.error("[boot] fatal:", err); process.exit(1); });
