import { Deck, type Card } from "./deck.js";
import { evaluateBest, describeHand, type HandRank } from "./evaluator.js";
import {
  buildPots, splitPot, computeRake, DEFAULT_RAKE,
  type Contribution, type RakeConfig, type Payout,
} from "./pot.js";

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";
export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface Player {
  id: string;
  name: string;
  stack: number;
  seat: number;
  holeCards: Card[];
  /** total chips put into the pot this hand */
  committed: number;
  /** chips put in during the current street */
  streetBet: number;
  folded: boolean;
  allIn: boolean;
  /** has this player acted since the last raise on this street */
  acted: boolean;
}

export interface Action {
  playerId: string;
  type: ActionType;
  amount: number;
  street: Street;
}

export interface HandResult {
  payouts: Payout[];
  rake: number;
  winners: { playerId: string; hand?: HandRank; description?: string }[];
}

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  rake?: RakeConfig;
}

export class HoldemHand {
  readonly players: Player[];
  readonly config: TableConfig;
  readonly board: Card[] = [];
  readonly actions: Action[] = [];
  street: Street = "preflop";
  private deck: Deck;
  private dealerSeat: number;
  private currentIndex: number = 0;
  private currentBet = 0;
  private minRaise: number;
  private lastAggressorIndex: number | null = null;
  sawFlop = false;
  result: HandResult | null = null;

  constructor(
    seatedPlayers: { id: string; name: string; stack: number; seat: number }[],
    dealerSeat: number,
    config: TableConfig,
    deck?: Deck
  ) {
    if (seatedPlayers.length < 2) throw new Error("Need at least 2 players");
    this.config = config;
    this.dealerSeat = dealerSeat;
    this.minRaise = config.bigBlind;
    this.deck = deck ?? new Deck();
    this.players = seatedPlayers
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        ...p,
        holeCards: [],
        committed: 0,
        streetBet: 0,
        folded: false,
        allIn: false,
        acted: false,
      }));
    this.start();
  }

  // ---------- setup ----------

  private indexOfSeat(seat: number): number {
    return this.players.findIndex((p) => p.seat === seat);
  }

  private nextIndex(from: number, predicate: (p: Player) => boolean = () => true): number {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (predicate(this.players[idx])) return idx;
    }
    return -1;
  }

  private start() {
    const dealerIdx = this.indexOfSeat(this.dealerSeat);
    if (dealerIdx === -1) throw new Error("Dealer seat not found");
    const headsUp = this.players.length === 2;

    // heads-up: dealer is small blind, acts first preflop
    const sbIdx = headsUp ? dealerIdx : this.nextIndex(dealerIdx);
    const bbIdx = this.nextIndex(sbIdx);

    this.postBlind(this.players[sbIdx], this.config.smallBlind);
    this.postBlind(this.players[bbIdx], this.config.bigBlind);
    this.currentBet = this.config.bigBlind;

    // deal two hole cards to each player
    for (let r = 0; r < 2; r++) {
      for (let i = 1; i <= this.players.length; i++) {
        const p = this.players[(dealerIdx + i) % this.players.length];
        p.holeCards.push(this.deck.deal());
      }
    }

    // first to act preflop: left of big blind
    this.currentIndex = this.nextIndex(bbIdx, (p) => !p.folded && !p.allIn);
    this.lastAggressorIndex = bbIdx;
  }

  private postBlind(p: Player, amount: number) {
    const put = Math.min(amount, p.stack);
    p.stack -= put;
    p.committed += put;
    p.streetBet += put;
    if (p.stack === 0) p.allIn = true;
  }

  // ---------- public state ----------

  get currentPlayer(): Player | null {
    if (this.street === "showdown" || this.street === "complete") return null;
    return this.players[this.currentIndex] ?? null;
  }

  get pot(): number {
    return this.players.reduce((s, p) => s + p.committed, 0);
  }

  get toCall(): number {
    const p = this.currentPlayer;
    if (!p) return 0;
    return Math.max(0, this.currentBet - p.streetBet);
  }

  get minRaiseTo(): number {
    return this.currentBet + this.minRaise;
  }

  legalActions(): ActionType[] {
    const p = this.currentPlayer;
    if (!p) return [];
    const acts: ActionType[] = ["fold"];
    if (this.toCall === 0) acts.push("check");
    else if (p.stack > this.toCall) acts.push("call");
    if (this.currentBet === 0 && p.stack > 0) acts.push("bet");
    else if (p.stack > this.toCall) acts.push("raise");
    if (p.stack > 0) acts.push("allin");
    return acts;
  }

  // ---------- actions ----------

  act(playerId: string, type: ActionType, amount = 0): void {
    const p = this.currentPlayer;
    if (!p) throw new Error("Hand is over");
    if (p.id !== playerId) throw new Error(`Not ${playerId}'s turn`);
    if (!this.legalActions().includes(type)) {
      throw new Error(`Illegal action ${type} for ${playerId}`);
    }

    switch (type) {
      case "fold":
        p.folded = true;
        break;

      case "check":
        break;

      case "call": {
        this.commit(p, this.toCall);
        break;
      }

      case "bet":
      case "raise": {
        // amount = total to raise TO on this street
        if (amount < this.minRaiseTo && amount < p.streetBet + p.stack) {
          throw new Error(`Raise must be at least ${this.minRaiseTo}`);
        }
        const target = Math.min(amount, p.streetBet + p.stack);
        const raiseSize = target - this.currentBet;
        this.commit(p, target - p.streetBet);
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        this.currentBet = target;
        this.resetActedExcept(p);
        this.lastAggressorIndex = this.currentIndex;
        break;
      }

      case "allin": {
        const target = p.streetBet + p.stack;
        const isRaise = target > this.currentBet;
        this.commit(p, p.stack);
        if (isRaise) {
          const raiseSize = target - this.currentBet;
          if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
          this.currentBet = target;
          this.resetActedExcept(p);
          this.lastAggressorIndex = this.currentIndex;
        }
        break;
      }
    }

    p.acted = true;
    this.actions.push({ playerId, type, amount, street: this.street });
    this.advance();
  }

  private commit(p: Player, amount: number) {
    const put = Math.min(amount, p.stack);
    p.stack -= put;
    p.committed += put;
    p.streetBet += put;
    if (p.stack === 0) p.allIn = true;
  }

  private resetActedExcept(p: Player) {
    for (const q of this.players) if (q !== p) q.acted = false;
  }

  private activePlayers(): Player[] {
    return this.players.filter((p) => !p.folded);
  }

  private playersWhoCanAct(): Player[] {
    return this.players.filter((p) => !p.folded && !p.allIn);
  }

  private advance() {
    // everyone folded but one -> instant win
    if (this.activePlayers().length === 1) {
      this.finish();
      return;
    }

    // street complete when all non-allin players have acted and matched currentBet
    const canAct = this.playersWhoCanAct();
    const streetDone =
      canAct.length === 0 ||
      canAct.every((p) => p.acted && p.streetBet === this.currentBet);

    if (streetDone) {
      this.nextStreet();
      return;
    }

    this.currentIndex = this.nextIndex(this.currentIndex, (p) => !p.folded && !p.allIn);
  }

  private nextStreet() {
    for (const p of this.players) {
      p.streetBet = 0;
      p.acted = false;
    }
    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;

    switch (this.street) {
      case "preflop":
        this.street = "flop";
        this.deck.deal(); // burn
        this.board.push(this.deck.deal(), this.deck.deal(), this.deck.deal());
        this.sawFlop = true;
        break;
      case "flop":
        this.street = "turn";
        this.deck.deal();
        this.board.push(this.deck.deal());
        break;
      case "turn":
        this.street = "river";
        this.deck.deal();
        this.board.push(this.deck.deal());
        break;
      case "river":
        this.finish();
        return;
    }

    // if fewer than 2 players can act, run out the board
    if (this.playersWhoCanAct().length < 2) {
      this.nextStreet();
      return;
    }

    // postflop: first to act is left of dealer
    const dealerIdx = this.indexOfSeat(this.dealerSeat);
    this.currentIndex = this.nextIndex(dealerIdx, (p) => !p.folded && !p.allIn);
  }

  // ---------- showdown ----------

  private finish() {
    // make sure board is fully dealt if we got here with all-ins
    while (this.board.length < 5 && this.activePlayers().length > 1) {
      this.deck.deal();
      this.board.push(this.deck.deal());
      if (this.board.length >= 3) this.sawFlop = true;
    }

    this.street = "showdown";

    const contribs: Contribution[] = this.players.map((p) => ({
      playerId: p.id,
      amount: p.committed,
      eligible: !p.folded,
    }));

    const rakeCfg = this.config.rake ?? DEFAULT_RAKE;
    const totalPot = this.pot;
    const rake = computeRake(totalPot, this.config.bigBlind, this.sawFlop, rakeCfg);

    const pots = buildPots(contribs);
    // take rake from the main pot (first pot) proportionally — simplest fair approach
    if (rake > 0 && pots.length) {
      let remainingRake = rake;
      for (const pot of pots) {
        const take = Math.min(pot.amount, remainingRake);
        pot.amount -= take;
        remainingRake -= take;
        if (remainingRake === 0) break;
      }
    }

    const active = this.activePlayers();
    const handOf = new Map<string, HandRank>();
    if (active.length > 1) {
      for (const p of active) {
        handOf.set(p.id, evaluateBest([...p.holeCards, ...this.board]));
      }
    }

    const payoutTotals = new Map<string, number>();
    const winnerSet = new Set<string>();

    for (const pot of pots) {
      let winners: string[];
      if (active.length === 1) {
        winners = [active[0].id];
      } else {
        const eligible = pot.eligible.filter((id) => handOf.has(id));
        const bestScore = Math.max(...eligible.map((id) => handOf.get(id)!.score));
        winners = eligible.filter((id) => handOf.get(id)!.score === bestScore);
      }
      for (const pay of splitPot(pot.amount, winners)) {
        payoutTotals.set(pay.playerId, (payoutTotals.get(pay.playerId) ?? 0) + pay.amount);
        winnerSet.add(pay.playerId);
      }
    }

    const payouts: Payout[] = [...payoutTotals.entries()].map(([playerId, amount]) => ({
      playerId, amount,
    }));
    for (const pay of payouts) {
      const p = this.players.find((q) => q.id === pay.playerId)!;
      p.stack += pay.amount;
    }

    this.result = {
      payouts,
      rake,
      winners: [...winnerSet].map((id) => {
        const hand = handOf.get(id);
        return { playerId: id, hand, description: hand ? describeHand(hand) : "Uncontested" };
      }),
    };
    this.street = "complete";
  }
}
