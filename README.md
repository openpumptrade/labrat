# LABRAT

A 3D lab rat with **Jev** (TypeSafe AI's System One model) for a brain, running the treasury of a pump.fun coin
from inside a Skinner box with three levers. Every 3 minutes, on a fixed clock:

1. **The pot** — the coin's unclaimed creator fees (SOL).
2. **Jev sets the odds** — one call to `POST /v1/systemone` with a small numeric state and the public protocol
   (`GET /api/protocol`): `action` = `burn | bless | stash`, plus two readings (`dumping`, `momentum`).
   No key or model unreachable → equal odds on every lever and the trial is tagged `instinct`, never `jev`.
3. **A Solana block pulls a lever** — seed = blockhash of the newest *finalized* block, read after Jev answered and after the holders were counted:
   - `ticket = int(sha256(blockhash:trialId:arm)[:8], 16) % 10000` → **burn** if `ticket < round(P(burn)·10000)`,
     **bless** if `ticket < round(P(burn)·10000) + round(P(bless)·10000)`, else **stash**
   - on a bless: `ticket = int(sha256(blockhash:trialId:bless)[:16], 16) % Σbalances` → the holder whose slice of the cumulative balances contains the ticket. **Your bag is your odds.**
4. **The rat obeys** — BURN / BLESS: claim 100% → ONE market buy (curve → PumpSwap → Jupiter) → burn the tokens bought, or send all of them to the blessed holder.
   STASH: nothing moves on chain; the pot rolls into the next trial, so the next pull is bigger.

The draw = the `BLESS_TOP_N` (100) largest real wallets; program-owned accounts (curve, pools, lockers) and the engine wallet are excluded.
Slot, blockhash, odds and the holder snapshot are stored with every trial; the page recomputes both draws in the browser.

The engine keeps its own ledger (`bank_quote`, `owed_raw`): it only spends what it claimed and only burns / gives away what it bought. The dev bag in the same wallet is never touched.

## Run

```bash
cd backend && cp .env.example .env    # TYPESAFE_API_KEY, WALLET_PRIVATE_KEY (creator wallet), TOKEN_MINT
npm install
createdb labrat
npm run dev                            # http://localhost:4000
npm run ask -- pump                    # ask Jev the protocol once (needs the key)
npm run launch -- --live --image public/logo.png   # or launch from pump.fun with the engine wallet as creator
npm run verify <mint>                  # simulate claim + buy for a mint, free
```

Without `WALLET_PRIVATE_KEY` the engine runs in watch mode (dry trials). `SCHEDULER_ENABLED=false` is the kill switch.
Deploy: Railway builds the root `Dockerfile` (engine + page + Postgres); Vercel serves `backend/public` and rewrites `/api/*` to the engine (`backend/public/vercel.json` — replace `RAILWAY_ENGINE_URL`). Redeploy the engine only while a trial is idle.
