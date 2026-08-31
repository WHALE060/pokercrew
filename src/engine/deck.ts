import { randomInt } from "node:crypto";

export type Suit = "s" | "h" | "d" | "c";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const SUITS: Suit[] = ["s", "h", "d", "c"];

const RANK_CHARS: Record<Rank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "T", 11: "J", 12: "Q", 13: "K", 14: "A",
};

export function cardToString(c: Card): string {
  return RANK_CHARS[c.rank] + c.suit;
}

export function parseCard(s: string): Card {
  const r = s[0].toUpperCase();
  const suit = s[1].toLowerCase() as Suit;
  const rank = (Object.keys(RANK_CHARS) as unknown as string[]).find(
    (k) => RANK_CHARS[Number(k) as Rank] === r
  );
  if (!rank || !SUITS.includes(suit)) throw new Error(`Bad card: ${s}`);
  return { rank: Number(rank) as Rank, suit };
}

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return deck;
}

/**
 * Fisher-Yates shuffle using Node's crypto.randomInt — a CSPRNG, not Math.random.
 * This is the basis of provable fairness: no seed manipulation, no engagement skewing.
 */
export function shuffle(deck: Card[]): Card[] {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export class Deck {
  private cards: Card[];

  constructor(cards?: Card[]) {
    this.cards = cards ?? shuffle(freshDeck());
  }

  deal(): Card {
    const c = this.cards.pop();
    if (!c) throw new Error("Deck is empty");
    return c;
  }

  remaining(): number {
    return this.cards.length;
  }
}
