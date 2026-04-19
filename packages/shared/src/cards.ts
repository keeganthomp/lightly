/**
 * Card primitives + deterministic shuffle + 7-card hand evaluator.
 *
 * Shuffle is VRF-seed-driven: given the same 32-byte seed, every client can
 * re-derive the deck and audit the dealer post-hand.
 */

export type Suit = "s" | "h" | "d" | "c";
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
export type Card = `${Rank}${Suit}`;

const RANKS: Rank[] = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS: Suit[] = ["s","h","d","c"];

export const STANDARD_DECK: Card[] = (() => {
  const d: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) d.push(`${r}${s}` as Card);
  return d;
})();

export function rankValue(r: Rank): number {
  return RANKS.indexOf(r) + 2; // 2..14
}

// ---------- Deterministic shuffle (Fisher-Yates driven by a PRNG keyed to a seed) ----------

/**
 * xoshiro256++ PRNG seeded from a 32-byte buffer.
 * Produces 64-bit numbers as two 32-bit parts to avoid BigInt hotpath in older JS engines.
 */
export function createRng(seed: Uint8Array): () => number {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  // Split 32 bytes into 4 x u64 state.
  const s = new BigUint64Array(4);
  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  for (let i = 0; i < 4; i++) s[i] = view.getBigUint64(i * 8, true);
  // Avoid zero state.
  if (s[0] === 0n && s[1] === 0n && s[2] === 0n && s[3] === 0n) s[0] = 1n;

  const MASK = 0xFFFFFFFFFFFFFFFFn;
  function rotl(x: bigint, k: bigint): bigint {
    return ((x << k) | (x >> (64n - k))) & MASK;
  }
  return (): number => {
    const a = s[0]!, b = s[1]!, c = s[2]!, d = s[3]!;
    const result = (rotl((a + d) & MASK, 23n) + a) & MASK;
    const t = (b << 17n) & MASK;
    s[2] = (c ^ a) & MASK;
    s[3] = (d ^ b) & MASK;
    s[1] = (b ^ s[2]!) & MASK;
    s[0] = (a ^ s[3]!) & MASK;
    s[2] = (s[2]! ^ t) & MASK;
    s[3] = rotl(s[3]!, 45n);
    // Convert to [0, 1) float from top 53 bits.
    return Number(result >> 11n) / 2 ** 53;
  };
}

export function shuffleDeck(seed: Uint8Array, deck: Card[] = STANDARD_DECK): Card[] {
  const rng = createRng(seed);
  const out = [...deck];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// ---------- 7-card poker hand evaluator ----------
//
// Returns a numeric rank where bigger = better. Encoded as:
//   category << 20 | primary << 16 | secondary << 12 | tertiary << 8 | k1 << 4 | k2
// Categories: 0=high, 1=pair, 2=two pair, 3=trips, 4=straight, 5=flush,
//             6=full, 7=quads, 8=straight flush

export type HandRank = {
  score: number;
  category: string;
  best5: Card[];
};

type CardBits = { rank: number; suit: Suit };

export function evaluate7(cards: Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate7 expects 5..7 cards, got ${cards.length}`);
  }
  const parsed: CardBits[] = cards.map((c) => ({
    rank: rankValue(c[0] as Rank),
    suit: c[1] as Suit,
  }));
  let best: HandRank | null = null;
  // Try all 5-card combos (up to C(7,5)=21).
  const idx = [0, 1, 2, 3, 4];
  const n = cards.length;
  const combos = combinations(n, 5);
  for (const combo of combos) {
    const hand5 = combo.map((i) => cards[i]!);
    const parsed5 = combo.map((i) => parsed[i]!);
    const r = score5(parsed5);
    if (!best || r.score > best.score) {
      best = { ...r, best5: hand5 };
    }
  }
  return best!;
}

function combinations(n: number, k: number): number[][] {
  const res: number[][] = [];
  const cur: number[] = [];
  function rec(start: number): void {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  }
  rec(0);
  return res;
}

function score5(cards: CardBits[]): Omit<HandRank, "best5"> {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  // Straight detection (including wheel A-2-3-4-5)
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) straightHigh = unique[0]!;
    else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      straightHigh = 5; // wheel
    }
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const g1 = groups[0]!;
  const g2 = groups[1] ?? [0, 0];
  const g3 = groups[2] ?? [0, 0];

  if (isFlush && straightHigh > 0) {
    return cat(8, straightHigh);
  }
  if (g1[1] === 4) {
    const kicker = groups[1]![0];
    return cat(7, g1[0], kicker);
  }
  if (g1[1] === 3 && g2[1] >= 2) {
    return cat(6, g1[0], g2[0]);
  }
  if (isFlush) {
    return catFromRanks(5, ranks);
  }
  if (straightHigh > 0) {
    return cat(4, straightHigh);
  }
  if (g1[1] === 3) {
    return cat(3, g1[0], g2[0], g3[0]);
  }
  if (g1[1] === 2 && g2[1] === 2) {
    const high = Math.max(g1[0], g2[0]);
    const low = Math.min(g1[0], g2[0]);
    return cat(2, high, low, g3[0]);
  }
  if (g1[1] === 2) {
    return cat(1, g1[0], g2[0], g3[0], groups[3]?.[0] ?? 0);
  }
  return catFromRanks(0, ranks);
}

const CAT_NAMES = [
  "High Card", "Pair", "Two Pair", "Trips", "Straight", "Flush", "Full House", "Quads", "Straight Flush",
] as const;

function cat(
  c: number,
  p: number,
  s = 0,
  t = 0,
  k1 = 0,
  k2 = 0,
): Omit<HandRank, "best5"> {
  const score = (c << 24) | (p << 20) | (s << 16) | (t << 12) | (k1 << 8) | (k2 << 4);
  return { score, category: CAT_NAMES[c]! };
}

function catFromRanks(c: number, ranks: number[]): Omit<HandRank, "best5"> {
  return cat(c, ranks[0]!, ranks[1]!, ranks[2]!, ranks[3]!, ranks[4]!);
}

// ---------- Commit-reveal helpers ----------
//
// seed = sha256(vrf_proof || hand_id || table_id)
// commitment = sha256(seed) — published before cards are dealt
// revealed post-hand along with the proof → anyone can audit.

export async function seedCommit(seed: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", seed as unknown as BufferSource);
  return new Uint8Array(buf);
}
