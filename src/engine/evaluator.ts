import type { Card, Rank } from "./deck.js";

export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

export const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High card",
  [HandCategory.Pair]: "Pair",
  [HandCategory.TwoPair]: "Two pair",
  [HandCategory.Trips]: "Three of a kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full house",
  [HandCategory.Quads]: "Four of a kind",
  [HandCategory.StraightFlush]: "Straight flush",
};

export interface HandRank {
  category: HandCategory;
  /** Tiebreak ranks in significance order (e.g. for two pair: [highPair, lowPair, kicker]) */
  kickers: Rank[];
  /** Single comparable number: higher wins */
  score: number;
  /** The 5 cards that make the hand */
  cards: Card[];
}

function scoreOf(category: HandCategory, kickers: Rank[]): number {
  // base-15 packing: category dominates, then kickers in order
  let s = category;
  for (let i = 0; i < 5; i++) {
    s = s * 15 + (kickers[i] ?? 0);
  }
  return s;
}

/** Evaluate exactly 5 cards. */
export function evaluate5(cards: Card[]): HandRank {
  if (cards.length !== 5) throw new Error("evaluate5 needs exactly 5 cards");

  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // count ranks
  const counts = new Map<Rank, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // groups sorted by count desc, then rank desc
  const groups = [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || b[0] - a[0]
  );

  // straight detection (handle wheel A-2-3-4-5)
  const unique = [...new Set(ranks)];
  let straightHigh: Rank | null = null;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (
      unique[0] === 14 && unique[1] === 5 && unique[2] === 4 &&
      unique[3] === 3 && unique[4] === 2
    ) straightHigh = 5;
  }

  let category: HandCategory;
  let kickers: Rank[];

  if (straightHigh !== null && isFlush) {
    category = HandCategory.StraightFlush;
    kickers = [straightHigh];
  } else if (groups[0][1] === 4) {
    category = HandCategory.Quads;
    kickers = [groups[0][0], groups[1][0]];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = HandCategory.FullHouse;
    kickers = [groups[0][0], groups[1][0]];
  } else if (isFlush) {
    category = HandCategory.Flush;
    kickers = ranks;
  } else if (straightHigh !== null) {
    category = HandCategory.Straight;
    kickers = [straightHigh];
  } else if (groups[0][1] === 3) {
    category = HandCategory.Trips;
    kickers = [groups[0][0], groups[1][0], groups[2][0]];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = HandCategory.TwoPair;
    kickers = [groups[0][0], groups[1][0], groups[2][0]];
  } else if (groups[0][1] === 2) {
    category = HandCategory.Pair;
    kickers = [groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
  } else {
    category = HandCategory.HighCard;
    kickers = ranks;
  }

  return { category, kickers, score: scoreOf(category, kickers), cards };
}

/** Evaluate the best 5-card hand from 5–7 cards. */
export function evaluateBest(cards: Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error("evaluateBest needs 5 to 7 cards");
  }
  if (cards.length === 5) return evaluate5(cards);

  let best: HandRank | null = null;
  const n = cards.length;
  // iterate all 5-card combinations
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const hr = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || hr.score > best.score) best = hr;
          }
  return best!;
}

export function describeHand(hr: HandRank): string {
  return CATEGORY_NAMES[hr.category];
}
