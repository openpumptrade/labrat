import { createHash } from "node:crypto";
import { config } from "./config.js";
import { randomBeacon } from "./solana.js";

/// The rat's brain. Jev is TypeSafe AI's System One model: it does not chat, it
/// answers typed questions (choice / noul) about a `state` with calibrated
/// probabilities, in 70–500 ms. One HTTP call per trial:
///   POST {baseUrl}/systemone  { model, state, questions } → { answers, usage }
/// The protocol below is IMMUTABLE and public (GET /api/protocol) — the page
/// prints these exact words, so anyone can see what the model is being asked.
///
/// Three levers in the box. Jev sets the ODDS, a Solana block pulls one, the rat obeys:
///   ticket = int(first 8 hex chars of sha256(`${blockhash}:${trialId}:arm`)) mod 10000
///   burn   if ticket < round(P(burn) · 10000)
///   bless  if ticket < round((P(burn) + P(bless)) · 10000)
///   stash  otherwise
/// and when the rat blesses, the same block picks the holder, weighted by balance:
///   ticket = int(first 16 hex chars of sha256(`${blockhash}:${trialId}:bless`)) mod Σ balances
///   winner = the holder whose slice of the cumulative balances contains the ticket
/// Slot, blockhash, odds and the holder snapshot are stored with the trial, so
/// anyone can recompute both draws (the page does it in the browser).

export const ARMS = ["burn", "bless", "stash"];
export const LINE = 10_000; // resolution of the arm draw

export const PROTOCOL = {
  action: {
    type: "choice",
    instructions: "You are the brain of a lab rat that runs the treasury of a memecoin. Every 3 minutes the rat pulls one of three levers. Two of them spend the whole pot of trading fees on ONE market buy of the coin — the buy pressure is the same for both, you only decide what happens to the tokens bought. The third lever spends nothing and keeps the pot for the next trial, so the next buy is bigger. Holders expect to see all three over time. Pick the lever that fits the market right now; when the market gives no clear signal, prefer the lever used less in recent_trials.",
    criteria: {
      burn: "Buy now and burn the tokens bought. Permanent supply reduction. Best when the coin is being sold off right now and needs defending.",
      bless: "Buy now and send all the tokens bought to ONE holder, drawn at random with odds proportional to the share of the supply they hold. A visible prize that holders talk about and that rewards holding more. Best when the coin is steady or has momentum and there are enough holders for a fair draw.",
      stash: "Spend nothing this trial. The pot rolls into the next trial and the next buy is bigger. Best when the pot is small relative to the market cap, when the market is quiet with thin flow, or right after a big move where a small buy would change nothing.",
    },
  },
  dumping: {
    type: "noul",
    instructions: "Is the coin being sold off right now?",
    criteria: { true: "Sells clearly outweigh buys and the price is falling", false: "Flow is balanced or buyers are in control" },
  },
  momentum: {
    type: "noul",
    instructions: "Does the coin have positive momentum right now?",
    criteria: { true: "Price and buy flow are both rising", false: "Flat, falling or no activity" },
  },
};

export const jevOnline = () => Boolean(config.jev.apiKey);
export const INSTINCT = { burn: 1 / 3, bless: 1 / 3, stash: 1 / 3 };

const sha = (s) => createHash("sha256").update(s).digest("hex");
const clamp01 = (v) => (isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : null);

/// the lines on the bar, in ARMS order: burn | bless | stash
export function armLines(probs) {
  const burnLine = Math.round(Math.max(0, Math.min(1, probs.burn)) * LINE);
  const blessLine = Math.min(LINE, burnLine + Math.round(Math.max(0, Math.min(1, probs.bless)) * LINE));
  return { burnLine, blessLine };
}

/// which lever, rolled against the odds with the block as dice
export function drawArm(blockhash, trialId, probs) {
  const input = `${blockhash}:${trialId}:arm`;
  const hash = sha(input);
  const ticket = parseInt(hash.slice(0, 8), 16) % LINE;
  const { burnLine, blessLine } = armLines(probs);
  const action = ticket < burnLine ? "burn" : ticket < blessLine ? "bless" : "stash";
  return { input, sha256: hash, ticket, burnLine, blessLine, of: LINE, action };
}

/// one holder, odds = balance / Σ balances. `holders` = [{owner, amountRaw}] in snapshot order.
export function drawHolder(blockhash, trialId, holders) {
  const total = holders.reduce((acc, h) => acc + BigInt(h.amountRaw), 0n);
  if (total <= 0n) return null;
  const input = `${blockhash}:${trialId}:bless`;
  const hash = sha(input);
  const ticket = BigInt(`0x${hash.slice(0, 16)}`) % total;
  let acc = 0n, index = holders.length - 1;
  for (let i = 0; i < holders.length; i++) { acc += BigInt(holders[i].amountRaw); if (ticket < acc) { index = i; break; } }
  const w = holders[index];
  return { input, sha256: hash, ticket: ticket.toString(), total: total.toString(), index, winner: w.owner, winnerPct: Number((BigInt(w.amountRaw) * 1_000_000n) / total) / 10_000 };
}

/// Ask Jev for the odds. Returns null when there is no key or the model cannot be reached —
/// nothing is ever labelled Jev that Jev did not answer.
async function askJev(state) {
  if (!jevOnline()) return null;
  const t0 = performance.now();
  try {
    const res = await fetch(`${config.jev.baseUrl}/systemone`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.jev.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.jev.model, state, questions: PROTOCOL }),
      signal: AbortSignal.timeout(config.jev.timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) throw new Error(`systemone → ${res.status} ${(await res.text()).slice(0, 120)}`);
    const json = await res.json();
    const a = json.answers || {};
    const p = {};
    for (const arm of ARMS) p[arm] = clamp01(a.action?.probabilities?.[arm]);
    if (ARMS.every((arm) => p[arm] === null)) {
      if (!ARMS.includes(a.action?.choice)) throw new Error("no usable answer to `action`");
      const c = clamp01(a.action?.confidence) ?? 1; // a bare choice: its confidence is the odds, the rest split evenly
      for (const arm of ARMS) p[arm] = arm === a.action.choice ? c : (1 - c) / (ARMS.length - 1);
    }
    for (const arm of ARMS) p[arm] ??= 0;
    const sum = ARMS.reduce((s, arm) => s + p[arm], 0);
    if (!(sum > 0)) throw new Error("probabilities sum to zero");
    const probs = {}; for (const arm of ARMS) probs[arm] = p[arm] / sum;
    const top = ARMS.includes(a.action?.choice) ? a.action.choice : ARMS.reduce((b, arm) => (probs[arm] > probs[b] ? arm : b), ARMS[0]);
    return {
      model: json.model || config.jev.model, latencyMs, probs, topAnswer: top,
      confidence: clamp01(a.action?.confidence),
      dumping: clamp01(a.dumping?.noul), momentum: clamp01(a.momentum?.noul),
      inputTokens: json.usage?.input_tokens ?? null,
    };
  } catch (err) {
    const msg = String(err.name === "TimeoutError" ? `timeout after ${config.jev.timeoutMs} ms` : err.message).slice(0, 140);
    console.warn(`[jev] ${msg} — instinct takes over`);
    return null;
  }
}

/// One decision. Never throws.
///   brain "jev"      — Jev answered: its probabilities are the odds
///   brain "instinct" — no model connected / unreachable: equal odds on every lever
/// `holders` is the snapshot taken BEFORE the block is read (the engine cannot see the dice first).
export async function decide(state, trialId, holders) {
  const jev = await askJev(state);
  const probs = jev ? jev.probs : { ...INSTINCT };
  const base = {
    brain: jev ? "jev" : "instinct", model: jev?.model || null, latencyMs: jev?.latencyMs ?? null,
    confidence: jev?.confidence ?? null, probs,
    readings: jev ? { top_answer: jev.topAnswer, dumping: jev.dumping, momentum: jev.momentum, inputTokens: jev.inputTokens } : {},
  };
  let beacon = null;
  try { beacon = await randomBeacon(); }
  catch (err) { console.warn(`[draw] beacon unavailable (${String(err.message).slice(0, 80)})`); }
  if (!beacon) {
    // no dice: the most probable lever wins, ties go to burn — and the record says so
    const likely = ARMS.reduce((b, arm) => (probs[arm] > probs[b] ? arm : b), ARMS[0]);
    return { ...base, action: likely, winner: null, note: "on-chain seed unavailable — no roll, the likeliest lever was pulled" };
  }
  const arm = drawArm(beacon.blockhash, trialId, probs);
  base.readings.seed = beacon;
  base.readings.draw = arm;
  let action = arm.action, winner = null, note = null;
  if (action === "bless") {
    const pick = holders?.length ? drawHolder(beacon.blockhash, trialId, holders) : null;
    if (pick) {
      winner = { ...holders[pick.index], pct: pick.winnerPct };
      base.readings.bless = { ...pick, holders: holders.map((h) => [h.owner, String(h.amountRaw)]) };
    } else { action = "burn"; note = "nobody to bless yet — burned instead"; }
  }
  return { ...base, action, winner, note };
}
