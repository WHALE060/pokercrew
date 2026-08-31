import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildServer } from "../src/server.js";
import { ConsoleMailer } from "../src/accounts.js";

async function boot() {
  const mailer = new ConsoleMailer();
  mailer.sendOtp = async (email, code, purpose) => { mailer.sent.push({ email, code, purpose }); };
  const { app, accounts, tables } = buildServer({
    jwtSecret: "test", mailer, actionTimeoutMs: 800, nextHandDelayMs: 50,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const lastCode = (email: string) => mailer.sent.filter((m) => m.email === email).at(-1)!.code;

  async function user(email: string, name: string) {
    await app.inject({ method: "POST", url: "/auth/signup/begin", payload: { email, displayName: name } });
    const r = await app.inject({
      method: "POST", url: "/auth/signup/complete", payload: { email, displayName: name, code: lastCode(email) },
    });
    const j = r.json();
    return { token: j.token as string, code: j.user.playerCode as string, h: { authorization: `Bearer ${j.token}` } };
  }
  return { app, accounts, tables, port, user };
}

/** Tiny WS client helper: buffers messages and lets tests await specific ones. */
class Player {
  ws: WebSocket;
  inbox: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const idx = this.waiters.findIndex((w) => w.pred(m));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(m);
      } else {
        this.inbox.push(m);
      }
      if (m.type === "state") this.lastState = m;
    });
  }
  lastState: any = null;
  ready() { return new Promise<void>((r) => this.ws.once("open", () => r())); }
  send(m: any) { this.ws.send(JSON.stringify(m)); }
  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error("timeout waiting for message"));
      }, timeoutMs);
      const wrapped = (m: any) => { clearTimeout(t); resolve(m); };
      this.waiters.push({ pred, resolve: wrapped });
    });
  }
  latestState(): any { return this.lastState; }
  close() { this.ws.close(); }
}

test("three players connect, sit, play a full hand; rake is logged and only admin can read it", async () => {
  const { app, accounts, port, user } = await boot();
  try {
    const owner = await user("own@x.com", "owner_o");
    const a = await user("a@x.com", "alice_a");
    const b = await user("b@x.com", "bob_b");

    // club + table
    const club = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "WS Club", joinMode: "open" } })).json();
    for (const u of [a, b]) await app.inject({ method: "POST", url: `/clubs/code/${club.clubCode}/join`, headers: u.h });
    const table = (await app.inject({
      method: "POST", url: `/clubs/${club.clubId}/tables`, headers: owner.h,
      payload: { name: "Main", smallBlind: 5, bigBlind: 10 },
    })).json();
    assert.equal(table.buyIn.min, 200);

    // non-member cannot see tables
    const stranger = await user("s@x.com", "stranger_s");
    const denied = await app.inject({ method: "GET", url: `/clubs/${club.clubId}/tables`, headers: stranger.h });
    assert.equal(denied.statusCode, 403);

    // connect three players
    const players = [owner, a, b].map(() => new Player(port));
    await Promise.all(players.map((p) => p.ready()));
    const [pO, pA, pB] = players;
    const creds = [owner, a, b];

    for (let i = 0; i < 3; i++) {
      players[i].send({ type: "auth", token: creds[i].token });
      const authed = await players[i].next((m) => m.type === "authed");
      assert.equal(authed.user.playerCode, creds[i].code);
      players[i].send({ type: "join", tableId: table.tableId });
      await players[i].next((m) => m.type === "state");
    }

    // sit: 1000 chips each (they start with 10,000)
    pO.send({ type: "sit", seat: 0, buyIn: 1000 });
    await pO.next((m) => m.type === "state" && m.table.seats.length === 1);
    pA.send({ type: "sit", seat: 1, buyIn: 1000 });
    // hand starts as soon as 2 are seated
    await pA.next((m) => m.type === "hand_started");
    pB.send({ type: "sit", seat: 2, buyIn: 1000 });
    await pB.next((m) => m.type === "state" && m.table.seats.length === 3);

    // chips left balances
    const bal = await app.inject({ method: "GET", url: "/me", headers: a.h });
    assert.equal(bal.json().chips, 9000);

    // play the hand: whoever is current acts. Everyone checks/calls so we reach showdown
    // (flop seen -> rake taken).
    const byCode = new Map(creds.map((c, i) => [c.code, players[i]]));
    let complete: any = null;
    pO.next((m) => m.type === "hand_complete", 8000).then((m) => { complete = m; }).catch(() => {});

    for (let step = 0; step < 60 && !complete; step++) {
      await new Promise((r) => setTimeout(r, 30));
      const cur = pO.latestState()?.table?.currentPlayerCode;
      if (!cur) continue;
      const actor = byCode.get(cur)!;
      const legal: string[] = actor.latestState()?.you?.legalActions ?? [];
      if (!legal.length) continue;
      const action = legal.includes("check") ? "check" : legal.includes("call") ? "call" : "fold";
      actor.send({ type: "act", action });
      await new Promise((r) => setTimeout(r, 40));
    }
    for (let i = 0; i < 50 && !complete; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(complete, "hand should complete");

    // the hand row + rake ledger exist (everyone called to showdown -> flop was seen -> rake > 0)
    const db = (accounts as any).db;
    const hand = db.prepare("SELECT * FROM hands ORDER BY played_at DESC LIMIT 1").get();
    assert.ok(hand, "hand persisted");
    // The hand started heads-up the moment two players sat (Bob joined mid-hand and waits for the next one):
    // SB 5 + BB 10, dealer calls -> pot 20; checks to the river; 5% of 20 = 1 (cap 30).
    assert.equal(hand.pot, 20);
    assert.equal(hand.rake, 1);
    assert.equal(JSON.parse(hand.players).length, 2);
    const ledger = db.prepare("SELECT SUM(amount) AS s FROM rake_ledger").get();
    assert.equal(ledger.s, 1);

    // chips conserved: seats total + rake == 3000
    const st = await app.inject({ method: "GET", url: `/tables/${table.tableId}`, headers: owner.h });
    const seatTotal = st.json().state.seats.reduce((s: number, x: any) => s + x.stack, 0);
    assert.equal(seatTotal + 1, 3000);

    // admin dashboard: players are locked out, admin sees rake per table/club
    const locked = await app.inject({ method: "GET", url: "/admin/rake/summary", headers: a.h });
    assert.equal(locked.statusCode, 403);
    db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run("own@x.com");
    const summary = await app.inject({ method: "GET", url: "/admin/rake/summary", headers: owner.h });
    assert.equal(summary.json().totalRake, 1);
    assert.ok(summary.json().totalHands >= 1);
    const byTable = await app.inject({ method: "GET", url: "/admin/rake/by-table", headers: owner.h });
    assert.equal(byTable.json()[0].tableName, "Main");
    assert.equal(byTable.json()[0].rake, 1);
    const byClub = await app.inject({ method: "GET", url: "/admin/rake/by-club", headers: owner.h });
    assert.equal(byClub.json()[0].clubName, "WS Club");

    // leaving returns the stack to the balance
    pA.send({ type: "leave" });
    await new Promise((r) => setTimeout(r, 100));
    const after = await app.inject({ method: "GET", url: "/me", headers: a.h });
    assert.ok(after.json().chips >= 9000 && after.json().chips <= 10000);

    for (const p of players) p.close();
  } finally {
    await app.close();
  }
});

test("action timer auto-folds an idle player", async () => {
  const { app, port, user } = await boot();
  try {
    const owner = await user("t1@x.com", "timer_one");
    const other = await user("t2@x.com", "timer_two");
    const club = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Timer Club", joinMode: "open" } })).json();
    await app.inject({ method: "POST", url: `/clubs/code/${club.clubCode}/join`, headers: other.h });
    const table = (await app.inject({
      method: "POST", url: `/clubs/${club.clubId}/tables`, headers: owner.h,
      payload: { name: "T", smallBlind: 5, bigBlind: 10 },
    })).json();

    const p1 = new Player(port), p2 = new Player(port);
    await Promise.all([p1.ready(), p2.ready()]);
    p1.send({ type: "auth", token: owner.token }); await p1.next((m) => m.type === "authed");
    p2.send({ type: "auth", token: other.token }); await p2.next((m) => m.type === "authed");
    p1.send({ type: "join", tableId: table.tableId }); await p1.next((m) => m.type === "state");
    p2.send({ type: "join", tableId: table.tableId }); await p2.next((m) => m.type === "state");
    p1.send({ type: "sit", seat: 0, buyIn: 500 });
    p2.send({ type: "sit", seat: 1, buyIn: 500 });
    await p1.next((m) => m.type === "hand_started");

    // nobody acts; with 800ms timers the hand should resolve by itself
    const done = await p1.next((m) => m.type === "hand_complete", 5000);
    assert.ok(done.winners.length >= 1);
    p1.close(); p2.close();
  } finally {
    await app.close();
  }
});
