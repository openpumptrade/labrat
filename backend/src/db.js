import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, {
  max: 6,
  idle_timeout: 30,
  ssl: config.databaseUrl.includes("localhost") || config.databaseUrl.includes("127.0.0.1") ? false : "require",
  transform: { undefined: null },
  onnotice: () => {},
});

/// Idempotent schema — runs at boot (Railway has no shell for migrations).
/// One row per trial: what the rat's brain saw (`state`), the odds it set (`probs`,
/// `brain`, `latency_ms`), the dice (`readings.seed / draw / bless`), what the engine
/// did with it, and — one interval later — what the price did (`price_after`).
/// Amounts are in the coin's QUOTE asset (SOL, or a custom pair) — `quote_usd` is
/// the USD price of one unit of it at trial time.
export async function ensureSchema() {
  await sql`create table if not exists meta (key text primary key, value text not null)`;
  await sql`create table if not exists trials (
    id serial primary key, ts int not null,
    status text not null default 'deciding',
    dry boolean not null default false,
    brain text not null default 'instinct',
    model text, latency_ms int,
    action text, confidence double precision,
    probs jsonb, readings jsonb, state jsonb,
    pot_quote double precision not null default 0,
    claimed_quote double precision not null default 0,
    spent_quote double precision not null default 0,
    tokens_bought double precision not null default 0,
    tokens_burned double precision not null default 0,
    tokens_blessed double precision not null default 0,
    winner text, winner_pct double precision,
    quote_usd double precision, price_usd double precision, sol_usd double precision, supply_after double precision,
    price_after double precision, scored_at int,
    venue text, claim_tx text, buy_tx text, burn_tx text, bless_tx text,
    note text, finished_at int)`;
  await sql`create index if not exists trials_ts on trials (ts)`;
  await sql`create index if not exists trials_winner on trials (winner) where winner is not null`;
  await sql`create table if not exists samples (ts int primary key, price_usd double precision not null, mcap_usd double precision not null, supply double precision)`;
}

/// One engine at a time. A redeploy briefly runs the old and the new container side by
/// side; two engines sharing one wallet and one ledger would step on each other (it happened:
/// a finished trial got marked failed and the ledger kept a stale "owed" amount). The lock
/// is session-level on a reserved connection, so it frees itself when the old process exits.
export async function acquireEngineLock() {
  const conn = await sql.reserve();
  for (let i = 0; ; i++) {
    const [{ ok }] = await conn`select pg_try_advisory_lock(7710077) as ok`;
    if (ok) {
      // keep the session alive — the pool's idle timeout would close it and silently drop the lock
      setInterval(() => conn`select 1`.catch(() => {}), 10_000).unref();
      return;
    }
    if (i % 5 === 0) console.log("[boot] another engine still holds the lock — waiting for it to exit");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function getMeta(key, fallback = null) {
  const rows = await sql`select value from meta where key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}
export async function setMeta(key, value) {
  await sql`insert into meta (key, value) values (${key}, ${String(value)})
    on conflict (key) do update set value = excluded.value`;
}
