import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { ConsoleMailer } from "../src/accounts.js";

function makeApp() {
  const mailer = new ConsoleMailer();
  mailer.sendOtp = async (email, code, purpose) => { mailer.sent.push({ email, code, purpose }); };
  const { app, accounts } = buildServer({ jwtSecret: "test-secret", mailer });
  const lastCode = (email: string) =>
    mailer.sent.filter((m) => m.email === email.toLowerCase()).at(-1)!.code;
  return { app, accounts, mailer, lastCode };
}

async function signup(app: any, lastCode: any, email: string, displayName: string, password?: string) {
  const begin = await app.inject({
    method: "POST", url: "/auth/signup/begin",
    payload: { email, displayName, password },
  });
  assert.equal(begin.statusCode, 200, begin.body);
  const complete = await app.inject({
    method: "POST", url: "/auth/signup/complete",
    payload: { email, displayName, code: lastCode(email), password },
  });
  assert.equal(complete.statusCode, 200, complete.body);
  return complete.json();
}

test("signup creates account with unique player code and starting chips", async () => {
  const { app, lastCode } = makeApp();
  const res = await signup(app, lastCode, "Alice@Example.com", "alice_p");
  assert.match(res.user.playerCode, /^PC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(res.user.email, "alice@example.com");
  assert.equal(res.user.displayName, "alice_p");
  assert.equal(res.user.chips, 10000);
  assert.ok(res.token);
});

test("player codes are unique across accounts", async () => {
  const { app, lastCode } = makeApp();
  const codes = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const r = await signup(app, lastCode, `u${i}@x.com`, `user_${i}`);
    codes.add(r.user.playerCode);
  }
  assert.equal(codes.size, 20);
});

test("email is linked one-to-one: duplicate email rejected", async () => {
  const { app, lastCode } = makeApp();
  await signup(app, lastCode, "dup@x.com", "first_name");
  const res = await app.inject({
    method: "POST", url: "/auth/signup/begin",
    payload: { email: "DUP@x.com", displayName: "second_name" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "email_taken");
});

test("display names are unique (case-insensitive)", async () => {
  const { app, lastCode } = makeApp();
  await signup(app, lastCode, "a@x.com", "TheShark");
  const res = await app.inject({
    method: "POST", url: "/auth/signup/begin",
    payload: { email: "b@x.com", displayName: "theshark" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "display_name_taken");
});

test("wrong signup code is rejected and no account is created", async () => {
  const { app, accounts } = makeApp();
  await app.inject({
    method: "POST", url: "/auth/signup/begin",
    payload: { email: "c@x.com", displayName: "cara_c" },
  });
  const res = await app.inject({
    method: "POST", url: "/auth/signup/complete",
    payload: { email: "c@x.com", displayName: "cara_c", code: "000000" },
  });
  assert.equal(res.statusCode, 401);
  const login = await app.inject({
    method: "POST", url: "/auth/login/code/request", payload: { email: "c@x.com" },
  });
  assert.equal(login.statusCode, 200);
});

test("login with one-time code works", async () => {
  const { app, lastCode } = makeApp();
  await signup(app, lastCode, "otp@x.com", "otp_user");
  const req = await app.inject({
    method: "POST", url: "/auth/login/code/request", payload: { email: "otp@x.com" },
  });
  assert.equal(req.statusCode, 200);
  const verify = await app.inject({
    method: "POST", url: "/auth/login/code/verify",
    payload: { email: "otp@x.com", code: lastCode("otp@x.com") },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().user.displayName, "otp_user");
});

test("login with password works, wrong password fails", async () => {
  const { app, lastCode } = makeApp();
  await signup(app, lastCode, "pw@x.com", "pw_user", "supersecret1");
  const ok = await app.inject({
    method: "POST", url: "/auth/login/password",
    payload: { email: "pw@x.com", password: "supersecret1" },
  });
  assert.equal(ok.statusCode, 200);
  const bad = await app.inject({
    method: "POST", url: "/auth/login/password",
    payload: { email: "pw@x.com", password: "wrong" },
  });
  assert.equal(bad.statusCode, 401);
});

test("passwordless user can add a password later", async () => {
  const { app, lastCode } = makeApp();
  const { token } = await signup(app, lastCode, "later@x.com", "later_user");
  const set = await app.inject({
    method: "POST", url: "/me/password",
    headers: { authorization: `Bearer ${token}` },
    payload: { password: "newpassword9" },
  });
  assert.equal(set.statusCode, 200);
  const login = await app.inject({
    method: "POST", url: "/auth/login/password",
    payload: { email: "later@x.com", password: "newpassword9" },
  });
  assert.equal(login.statusCode, 200);
});

test("session token authenticates /me and logout revokes it", async () => {
  const { app, lastCode } = makeApp();
  const { token } = await signup(app, lastCode, "sess@x.com", "sess_user");
  const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().email, "sess@x.com");

  await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
  const after = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.statusCode, 401);
});

test("display name is locked: no player endpoint can change it, only admin", async () => {
  const { app, accounts, lastCode } = makeApp();
  const alice = await signup(app, lastCode, "lock@x.com", "locked_name");
  const bob = await signup(app, lastCode, "bob@x.com", "bob_b");

  // a normal player trying the admin route is forbidden
  const attempt = await app.inject({
    method: "POST", url: `/admin/players/${alice.user.playerCode}/display-name`,
    headers: { authorization: `Bearer ${bob.token}` },
    payload: { displayName: "hacked" },
  });
  assert.equal(attempt.statusCode, 403);

  // promote bob to admin directly in DB (simulating the owner account)
  (accounts as any).db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run("bob@x.com");
  const ok = await app.inject({
    method: "POST", url: `/admin/players/${alice.user.playerCode}/display-name`,
    headers: { authorization: `Bearer ${bob.token}` },
    payload: { displayName: "renamed_ok" },
  });
  assert.equal(ok.statusCode, 200);
  const look = await app.inject({ method: "GET", url: `/players/${alice.user.playerCode}` });
  assert.equal(look.json().displayName, "renamed_ok");
});

test("public lookup by player code returns only name and code", async () => {
  const { app, lastCode } = makeApp();
  const r = await signup(app, lastCode, "pub@x.com", "pub_user");
  const look = await app.inject({ method: "GET", url: `/players/${r.user.playerCode.toLowerCase()}` });
  assert.equal(look.statusCode, 200);
  assert.deepEqual(look.json(), { playerCode: r.user.playerCode, displayName: "pub_user" });
});

test("admin directory shows player code ↔ email ↔ name; players are locked out", async () => {
  const { app, accounts, lastCode } = makeApp();
  const owner = await signup(app, lastCode, "owner@x.com", "the_owner");
  const a = await signup(app, lastCode, "anna@x.com", "anna_a");
  const b = await signup(app, lastCode, "ben@x.com", "ben_b");

  // a normal player cannot see the directory
  const denied = await app.inject({
    method: "GET", url: "/admin/players", headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(denied.statusCode, 403);

  // make owner admin
  (accounts as any).db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run("owner@x.com");

  const list = await app.inject({
    method: "GET", url: "/admin/players", headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.total, 3);
  const anna = body.players.find((p: any) => p.email === "anna@x.com");
  assert.equal(anna.playerCode, a.user.playerCode);
  assert.equal(anna.displayName, "anna_a");

  // search by player code
  const search = await app.inject({
    method: "GET", url: `/admin/players?search=${b.user.playerCode}`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(search.json().total, 1);
  assert.equal(search.json().players[0].email, "ben@x.com");

  // single player detail includes sessions
  const detail = await app.inject({
    method: "GET", url: `/admin/players/${a.user.playerCode}`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().email, "anna@x.com");
  assert.ok(Array.isArray(detail.json().sessions) && detail.json().sessions.length >= 1);

  // CSV export
  const csv = await app.inject({
    method: "GET", url: "/admin/players/export.csv",
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers["content-type"] as string, /text\/csv/);
  const lines = csv.body.trim().split("\n");
  assert.equal(lines[0], "player_code,email,display_name,role,chips,created_at,last_login_at");
  assert.equal(lines.length, 4);
  assert.ok(csv.body.includes(`"${a.user.playerCode}","anna@x.com","anna_a"`));
});
