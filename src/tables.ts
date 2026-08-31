import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { nowIso } from "./db.js";
import { generateId } from "./ids.js";
import { AccountError } from "./accounts.js";
import { HoldemHand, cardToString, type ActionType, type Card } from "./engine/index.js";

export interface TableRow {
  id: string; club_id: string; name: string; small_blind: number; big_blind: number;
  min_buyin: number; max_buyin: number; max_seats: number; created_by: string; status: string; created_at: string;
}

export interface Seat {
  seat: number;
  userId: string;
  playerCode: string;
  displayName: string;
  stack: number;
  /** sitting out (won't be dealt in) */
  sittingOut: boolean;
  connected: boolean;
}

const ACTION_TIMEOUT_MS = 20_000;
const NEXT_HAND_DELAY_MS = 3_000;

/**
 * One live table. Holds seats + the current hand, drives the game loop,
 * and emits state snapshots for the WebSocket layer to broadcast.
 */
export class LiveTable extends EventEmitter {
  seats = new Map<number, Seat>();
  hand: HoldemHand | null = null;
  handNo = 0;
  dealerSeat = -1;
  private actionTimer: NodeJS.Timeout | null = null;
  private nextHandTimer: NodeJS.Timeout | null = null;
  closed = false;

  constructor(
    public readonly row: TableRow,
    private db: DatabaseSync,
    private opts: { actionTimeoutMs?: number; nextHandDelayMs?: number } = {}
  ) {
    super();
  }

  // ---------- seating ----------

  sit(user: { id: string; playerCode: string; displayName: string }, seat: number, buyIn: number) {
    if (this.closed) throw new AccountError("closed", "This table is closed", 410);
    if (seat < 0 || seat >= this.row.max_seats) throw new AccountError("bad_seat", "Invalid seat");
    if (this.seats.has(seat)) throw new AccountError("seat_taken", "That seat is taken", 409);
    if ([...this.seats.values()].some((s) => s.userId === user.id)) {
      throw new AccountError("already_seated", "You're already at this table", 409);
    }
    if (buyIn < this.row.min_buyin || buyIn > this.row.max_buyin) {
      throw new AccountError("bad_buyin", `Buy-in must be between ${this.row.min_buyin} and ${this.row.max_buyin}`);
    }
    const bal = (this.db.prepare("SELECT chips FROM users WHERE id = ?").get(user.id) as any)?.chips ?? 0;
    if (bal < buyIn) throw new AccountError("insufficient_chips", "Not enough chips", 402);

    // move chips from balance to table stack
    this.db.prepare("UPDATE users SET chips = chips - ? WHERE id = ?").run(buyIn, user.id);
    this.seats.set(seat, {
      seat, userId: user.id, playerCode: user.playerCode, displayName: user.displayName,
      stack: buyIn, sittingOut: false, connected: true,
    });
    this.emitState();
    this.maybeStartHand();
  }

  leave(userId: string) {
    const s = this.findSeat(userId);
    if (!s) return;
    // if in a live hand, fold them first
    if (this.hand && this.hand.street !== "complete") {
      const p = this.hand.players.find((p) => p.id === userId);
      if (p && !p.folded) {
        p.folded = true;
        if (this.hand.currentPlayer?.id === userId) {
          try { this.hand.act(userId, "fold"); } catch { /* hand may have ended */ }
          this.afterAction();
        }
      }
      // stack returns after hand completes (handled in finishHand via seats snapshot)
      s.sittingOut = true;
      s.connected = false;
      return;
    }
    this.cashOut(s);
  }

  private cashOut(s: Seat) {
    this.db.prepare("UPDATE users SET chips = chips + ? WHERE id = ?").run(s.stack, s.userId);
    this.seats.delete(s.seat);
    this.emitState();
  }

  setConnected(userId: string, connected: boolean) {
    const s = this.findSeat(userId);
    if (s) { s.connected = connected; this.emitState(); }
  }

  findSeat(userId: string): Seat | undefined {
    return [...this.seats.values()].find((s) => s.userId === userId);
  }

  // ---------- hand loop ----------

  private activeSeats(): Seat[] {
    return [...this.seats.values()]
      .filter((s) => !s.sittingOut && s.stack > 0)
      .sort((a, b) => a.seat - b.seat);
  }

  maybeStartHand() {
    if (this.closed || this.nextHandTimer) return;
    if (this.hand && this.hand.street !== "complete") return;
    if (this.activeSeats().length < 2) return;
    const delay = this.hand ? (this.opts.nextHandDelayMs ?? NEXT_HAND_DELAY_MS) : 0;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.startHand();
    }, delay);
  }

  private startHand() {
    const players = this.activeSeats();
    if (players.length < 2) { this.emitState(); return; }

    // advance dealer button to next occupied seat
    const seatNums = players.map((p) => p.seat);
    const next = seatNums.find((n) => n > this.dealerSeat) ?? seatNums[0];
    this.dealerSeat = next;

    this.handNo++;
    this.hand = new HoldemHand(
      players.map((p) => ({ id: p.userId, name: p.displayName, stack: p.stack, seat: p.seat })),
      this.dealerSeat,
      { smallBlind: this.row.small_blind, bigBlind: this.row.big_blind }
    );
    this.emit("hand_started", { handNo: this.handNo });
    this.emitState();
    this.armActionTimer();
    // engine may already be complete (e.g. everyone all-in from blinds)
    if (this.hand.street === "complete") this.finishHand();
  }

  act(userId: string, type: ActionType, amount = 0) {
    if (!this.hand || this.hand.street === "complete") {
      throw new AccountError("no_hand", "No hand in progress");
    }
    this.hand.act(userId, type, amount);
    this.afterAction();
  }

  private afterAction() {
    this.clearActionTimer();
    if (!this.hand) return;
    if (this.hand.street === "complete") {
      this.finishHand();
    } else {
      this.emitState();
      this.armActionTimer();
    }
  }

  private armActionTimer() {
    this.clearActionTimer();
    const p = this.hand?.currentPlayer;
    if (!p) return;
    this.actionTimer = setTimeout(() => {
      if (!this.hand || this.hand.currentPlayer?.id !== p.id) return;
      // auto: check if possible, else fold
      const legal = this.hand.legalActions();
      try {
        this.hand.act(p.id, legal.includes("check") ? "check" : "fold");
      } catch { /* ignore */ }
      this.emit("auto_action", { playerId: p.id });
      this.afterAction();
    }, this.opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS);
  }

  private clearActionTimer() {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null; }
  }

  private finishHand() {
    const h = this.hand!;
    const result = h.result!;

    // sync stacks back to seats
    const netBy = new Map<string, number>();
    for (const p of h.players) {
      const seat = this.findSeat(p.id);
      const before = seat?.stack ?? 0;
      if (seat) seat.stack = p.stack;
      netBy.set(p.id, p.stack - before);
    }

    // persist hand + rake ledger
    const handId = generateId();
    const playedAt = nowIso();
    this.db.prepare(
      `INSERT INTO hands (id, table_id, club_id, hand_no, pot, rake, board, winners, players, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      handId, this.row.id, this.row.club_id, this.handNo, h.pot, result.rake,
      h.board.map(cardToString).join(" "),
      JSON.stringify(result.winners.map((w) => ({
        playerCode: this.findSeat(w.playerId)?.playerCode ?? w.playerId,
        description: w.description,
      }))),
      JSON.stringify(h.players.map((p) => ({
        playerCode: this.findSeat(p.id)?.playerCode ?? p.id,
        holeCards: p.holeCards.map(cardToString),
        net: netBy.get(p.id) ?? 0,
      }))),
      playedAt
    );
    if (result.rake > 0) {
      this.db.prepare(
        `INSERT INTO rake_ledger (id, hand_id, table_id, club_id, amount, collected_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(generateId(), handId, this.row.id, this.row.club_id, result.rake, playedAt);
    }

    this.emit("hand_complete", {
      handNo: this.handNo,
      board: h.board.map(cardToString),
      winners: result.winners.map((w) => ({
        playerCode: this.findSeat(w.playerId)?.playerCode,
        amount: result.payouts.find((p) => p.playerId === w.playerId)?.amount ?? 0,
        description: w.description,
      })),
      showdown: h.players.filter((p) => !p.folded).map((p) => ({
        playerCode: this.findSeat(p.id)?.playerCode,
        holeCards: p.holeCards.map(cardToString),
      })),
    });

    // cash out anyone who left mid-hand or busted
    for (const s of [...this.seats.values()]) {
      if (s.sittingOut && !s.connected) this.cashOut(s);
    }

    this.emitState();
    this.maybeStartHand();
  }

  close() {
    this.closed = true;
    this.clearActionTimer();
    if (this.nextHandTimer) { clearTimeout(this.nextHandTimer); this.nextHandTimer = null; }
    for (const s of [...this.seats.values()]) this.cashOut(s);
    this.db.prepare("UPDATE tables SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), this.row.id);
    this.emit("closed");
  }

  // ---------- state snapshots ----------

  /** Public state (no hole cards). Each client additionally gets their own cards. */
  publicState() {
    const h = this.hand;
    return {
      tableId: this.row.id,
      name: this.row.name,
      blinds: { small: this.row.small_blind, big: this.row.big_blind },
      maxSeats: this.row.max_seats,
      handNo: this.handNo,
      dealerSeat: this.dealerSeat,
      street: h?.street ?? "waiting",
      board: h ? h.board.map(cardToString) : [],
      pot: h ? h.pot : 0,
      currentPlayerCode: h?.currentPlayer ? this.findSeat(h.currentPlayer.id)?.playerCode ?? null : null,
      toCall: h?.toCall ?? 0,
      minRaiseTo: h?.minRaiseTo ?? 0,
      seats: [...this.seats.values()].sort((a, b) => a.seat - b.seat).map((s) => {
        const p = h?.players.find((p) => p.id === s.userId);
        return {
          seat: s.seat,
          playerCode: s.playerCode,
          displayName: s.displayName,
          stack: p ? p.stack : s.stack,
          streetBet: p?.streetBet ?? 0,
          folded: p?.folded ?? false,
          allIn: p?.allIn ?? false,
          inHand: !!p,
          sittingOut: s.sittingOut,
          connected: s.connected,
        };
      }),
    };
  }

  privateState(userId: string) {
    const p = this.hand?.players.find((p) => p.id === userId);
    return {
      holeCards: p ? p.holeCards.map(cardToString) : [],
      legalActions: this.hand?.currentPlayer?.id === userId ? this.hand.legalActions() : [],
    };
  }

  private emitState() {
    this.emit("state");
  }
}

// ---------------------------------------------------------------------------

export class TableService {
  private live = new Map<string, LiveTable>();

  constructor(
    private db: DatabaseSync,
    private opts: { actionTimeoutMs?: number; nextHandDelayMs?: number } = {}
  ) {}

  private clubRole(clubId: string, userId: string): string | null {
    return (this.db.prepare("SELECT role FROM club_members WHERE club_id = ? AND user_id = ?")
      .get(clubId, userId) as any)?.role ?? null;
  }

  private isAdmin(userId: string): boolean {
    return (this.db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as any)?.role === "admin";
  }

  create(clubId: string, actorId: string, input: {
    name: string; smallBlind: number; bigBlind: number; minBuyin?: number; maxBuyin?: number; maxSeats?: number;
  }) {
    const role = this.clubRole(clubId, actorId);
    if (role !== "owner" && role !== "manager") {
      throw new AccountError("forbidden", "Only club owners and managers can create tables", 403);
    }
    if (input.smallBlind < 1 || input.bigBlind < input.smallBlind * 2 - 1 || input.bigBlind < 2) {
      throw new AccountError("bad_blinds", "Big blind must be at least double the small blind");
    }
    const maxSeats = input.maxSeats ?? 9;
    if (maxSeats < 2 || maxSeats > 9) throw new AccountError("bad_seats", "Seats must be 2–9");
    const minBuyin = input.minBuyin ?? input.bigBlind * 20;
    const maxBuyin = input.maxBuyin ?? input.bigBlind * 200;
    if (minBuyin > maxBuyin) throw new AccountError("bad_buyin", "Min buy-in exceeds max");

    const id = generateId();
    this.db.prepare(
      `INSERT INTO tables (id, club_id, name, small_blind, big_blind, min_buyin, max_buyin, max_seats, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, clubId, input.name.trim(), input.smallBlind, input.bigBlind, minBuyin, maxBuyin, maxSeats, actorId, nowIso());
    return this.summary(this.get(id));
  }

  private row(id: string): TableRow {
    const r = this.db.prepare("SELECT * FROM tables WHERE id = ?").get(id) as TableRow | undefined;
    if (!r) throw new AccountError("not_found", "Table not found", 404);
    return r;
  }

  /** Live table if it's currently running, without spinning one up or throwing. */
  peek(id: string): LiveTable | undefined {
    return this.live.get(id);
  }

  /** Get (or lazily spin up) the live table. */
  get(id: string): LiveTable {
    let t = this.live.get(id);
    if (!t) {
      const r = this.row(id);
      if (r.status !== "open") throw new AccountError("closed", "This table is closed", 410);
      t = new LiveTable(r, this.db, this.opts);
      this.live.set(id, t);
    }
    return t;
  }

  summary(t: LiveTable) {
    return {
      tableId: t.row.id,
      clubId: t.row.club_id,
      name: t.row.name,
      blinds: { small: t.row.small_blind, big: t.row.big_blind },
      buyIn: { min: t.row.min_buyin, max: t.row.max_buyin },
      maxSeats: t.row.max_seats,
      seated: t.seats.size,
      status: t.closed ? "closed" : "open",
    };
  }

  listForClub(clubId: string, actorId: string) {
    if (!this.clubRole(clubId, actorId) && !this.isAdmin(actorId)) {
      throw new AccountError("forbidden", "Join the club to see its tables", 403);
    }
    const rows = this.db.prepare("SELECT id FROM tables WHERE club_id = ? AND status = 'open' ORDER BY created_at")
      .all(clubId) as any[];
    return rows.map((r) => this.summary(this.get(r.id)));
  }

  /** Player must be a club member to sit. */
  assertCanSit(tableId: string, userId: string) {
    const r = this.row(tableId);
    if (!this.clubRole(r.club_id, userId)) {
      throw new AccountError("forbidden", "You must be a member of this club to play", 403);
    }
  }

  close(tableId: string, actorId: string) {
    const r = this.row(tableId);
    const role = this.clubRole(r.club_id, actorId);
    if (role !== "owner" && role !== "manager" && !this.isAdmin(actorId)) {
      throw new AccountError("forbidden", "Only club owners and managers can close tables", 403);
    }
    const t = this.get(tableId);
    t.close();
    this.live.delete(tableId);
    return { ok: true };
  }

  /** Shut everything down (tests / graceful exit). */
  closeAll() {
    for (const t of this.live.values()) t.close();
    this.live.clear();
  }

  // ---------- admin: rake reporting (owner only) ----------

  private assertAdmin(userId: string) {
    if (!this.isAdmin(userId)) throw new AccountError("forbidden", "Admin access required", 403);
  }

  private range(from?: string, to?: string) {
    const clauses: string[] = [];
    const params: any[] = [];
    if (from) { clauses.push("collected_at >= ?"); params.push(from); }
    if (to) { clauses.push("collected_at <= ?"); params.push(to); }
    return { where: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
  }

  adminRakeSummary(actorId: string, from?: string, to?: string) {
    this.assertAdmin(actorId);
    const { where, params } = this.range(from, to);
    const total = this.db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS rake, COUNT(*) AS raked_hands FROM rake_ledger ${where}`
    ).get(...params) as any;
    const hands = this.db.prepare(
      `SELECT COUNT(*) AS n FROM hands ${where.replace(/collected_at/g, "played_at")}`
    ).get(...params) as any;
    return { totalRake: total.rake, rakedHands: total.raked_hands, totalHands: hands.n, from: from ?? null, to: to ?? null };
  }

  adminRakeByClub(actorId: string, from?: string, to?: string) {
    this.assertAdmin(actorId);
    const { where, params } = this.range(from, to);
    return (this.db.prepare(
      `SELECT r.club_id, c.name, c.club_code, SUM(r.amount) AS rake, COUNT(*) AS raked_hands
       FROM rake_ledger r JOIN clubs c ON c.id = r.club_id ${where}
       GROUP BY r.club_id ORDER BY rake DESC`
    ).all(...params) as any[]).map((r) => ({
      clubId: r.club_id, clubCode: r.club_code, clubName: r.name, rake: r.rake, rakedHands: r.raked_hands,
    }));
  }

  adminRakeByTable(actorId: string, clubId?: string, from?: string, to?: string) {
    this.assertAdmin(actorId);
    const { where, params } = this.range(from, to);
    const clubClause = clubId ? (where ? " AND r.club_id = ?" : "WHERE r.club_id = ?") : "";
    return (this.db.prepare(
      `SELECT r.table_id, t.name, t.small_blind, t.big_blind, t.club_id, t.status,
              SUM(r.amount) AS rake, COUNT(*) AS raked_hands,
              (SELECT COUNT(*) FROM hands h WHERE h.table_id = r.table_id) AS total_hands
       FROM rake_ledger r JOIN tables t ON t.id = r.table_id ${where}${clubClause}
       GROUP BY r.table_id ORDER BY rake DESC`
    ).all(...params, ...(clubId ? [clubId] : [])) as any[]).map((r) => ({
      tableId: r.table_id, tableName: r.name, clubId: r.club_id, status: r.status,
      blinds: { small: r.small_blind, big: r.big_blind },
      rake: r.rake, rakedHands: r.raked_hands, totalHands: r.total_hands,
      avgRakePerHand: r.total_hands ? Math.round((r.rake / r.total_hands) * 100) / 100 : 0,
    }));
  }

  adminRakeDaily(actorId: string, days = 30) {
    this.assertAdmin(actorId);
    return (this.db.prepare(
      `SELECT substr(collected_at, 1, 10) AS day, SUM(amount) AS rake, COUNT(*) AS raked_hands
       FROM rake_ledger GROUP BY day ORDER BY day DESC LIMIT ?`
    ).all(days) as any[]).map((r) => ({ day: r.day, rake: r.rake, rakedHands: r.raked_hands }));
  }
}
