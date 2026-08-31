export interface RakeConfig {
  /** e.g. 0.05 for 5% */
  percent: number;
  /** cap expressed in big blinds, e.g. 3 */
  capBigBlinds: number;
  /** if true, no rake is taken when the hand ends before the flop */
  noFlopNoDrop: boolean;
}

export const DEFAULT_RAKE: RakeConfig = {
  percent: 0.05,
  capBigBlinds: 3,
  noFlopNoDrop: true,
};

/**
 * Compute platform rake for a pot.
 * Rake is taken from the pot before it is awarded; it goes to the platform pool.
 */
export function computeRake(
  potSize: number,
  bigBlind: number,
  sawFlop: boolean,
  cfg: RakeConfig = DEFAULT_RAKE
): number {
  if (cfg.noFlopNoDrop && !sawFlop) return 0;
  const raw = Math.floor(potSize * cfg.percent);
  const cap = Math.floor(cfg.capBigBlinds * bigBlind);
  return Math.min(raw, cap);
}

export interface Contribution {
  playerId: string;
  amount: number;
  /** false if player folded — they can't win but their chips stay in the pot */
  eligible: boolean;
}

export interface SidePot {
  amount: number;
  /** players who can win this pot */
  eligible: string[];
}

/**
 * Split total contributions into main pot + side pots based on all-in levels.
 * Classic algorithm: sort eligible contribution levels, slice the pot at each level.
 */
export function buildPots(contribs: Contribution[]): SidePot[] {
  const pots: SidePot[] = [];
  const remaining = contribs.map((c) => ({ ...c }));

  while (true) {
    const active = remaining.filter((c) => c.amount > 0);
    if (active.length === 0) break;

    // the smallest positive amount among ELIGIBLE players defines this pot's level;
    // if no eligible players have chips left, take the min of everyone (dead money)
    const eligibleActive = active.filter((c) => c.eligible);
    const level = eligibleActive.length
      ? Math.min(...eligibleActive.map((c) => c.amount))
      : Math.min(...active.map((c) => c.amount));

    let amount = 0;
    const eligible: string[] = [];
    for (const c of remaining) {
      if (c.amount <= 0) continue;
      const take = Math.min(level, c.amount);
      amount += take;
      c.amount -= take;
      if (c.eligible) eligible.push(c.playerId);
    }

    if (eligible.length === 0 && pots.length > 0) {
      // dead money with nobody eligible: fold into the previous pot
      pots[pots.length - 1].amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
  }

  return pots;
}

export interface Payout {
  playerId: string;
  amount: number;
}

/**
 * Award a pot to winners (ties split evenly; odd chips go to earliest in list).
 */
export function splitPot(amount: number, winners: string[]): Payout[] {
  if (winners.length === 0) return [];
  const base = Math.floor(amount / winners.length);
  let odd = amount - base * winners.length;
  return winners.map((w) => {
    const extra = odd > 0 ? 1 : 0;
    odd -= extra;
    return { playerId: w, amount: base + extra };
  });
}
