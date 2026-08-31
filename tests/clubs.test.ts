import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { ConsoleMailer } from "../src/accounts.js";

async function setup() {
  const mailer = new ConsoleMailer();
  mailer.sendOtp = async (email, code, purpose) => { mailer.sent.push({ email, code, purpose }); };
  const { app, accounts } = buildServer({ jwtSecret: "test", mailer });
  const lastCode = (email: string) => mailer.sent.filter((m) => m.email === email).at(-1)!.code;

  async function user(email: string, name: string) {
    await app.inject({ method: "POST", url: "/auth/signup/begin", payload: { email, displayName: name } });
    const r = await app.inject({
      method: "POST", url: "/auth/signup/complete",
      payload: { email, displayName: name, code: lastCode(email) },
    });
    const j = r.json();
    return { token: j.token, code: j.user.playerCode as string, h: { authorization: `Bearer ${j.token}` } };
  }

  const owner = await user("owner@x.com", "club_owner");
  const mgr = await user("mgr@x.com", "the_manager");
  const p1 = await user("p1@x.com", "player_one");
  const p2 = await user("p2@x.com", "player_two");
  return { app, accounts, owner, mgr, p1, p2 };
}

test("create a club: owner gets owner role and a unique club code", async () => {
  const { app, owner } = await setup();
  const r = await app.inject({
    method: "POST", url: "/clubs", headers: owner.h,
    payload: { name: "Friday Night Crew", description: "Home game, online" },
  });
  assert.equal(r.statusCode, 200, r.body);
  const club = r.json();
  assert.match(club.clubCode, /^CL-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal(club.memberCount, 1);
  assert.equal(club.joinMode, "approval");

  const mine = await app.inject({ method: "GET", url: "/clubs/mine", headers: owner.h });
  assert.equal(mine.json()[0].yourRole, "owner");
});

test("approval flow: request → pending → owner approves → member", async () => {
  const { app, owner, p1 } = await setup();
  const club = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Approval Club" } })).json();

  const join = await app.inject({
    method: "POST", url: `/clubs/code/${club.clubCode}/join`, headers: p1.h,
    payload: { message: "Let me in" },
  });
  assert.equal(join.json().status, "pending");

  const pending = await app.inject({ method: "GET", url: `/clubs/${club.clubId}/requests`, headers: owner.h });
  assert.equal(pending.json().length, 1);
  assert.equal(pending.json()[0].playerCode, p1.code);
  assert.equal(pending.json()[0].message, "Let me in");

  const approve = await app.inject({
    method: "POST", url: `/clubs/${club.clubId}/requests/${p1.code}/approve`, headers: owner.h,
  });
  assert.equal(approve.statusCode, 200);

  const detail = await app.inject({ method: "GET", url: `/clubs/${club.clubId}`, headers: p1.h });
  assert.equal(detail.json().yourRole, "member");
  assert.equal(detail.json().memberCount, 2);
});

test("open club: join instantly; invite-only club: blocked unless invited by player code", async () => {
  const { app, owner, p1, p2 } = await setup();
  const open = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Open Club", joinMode: "open" } })).json();
  const j = await app.inject({ method: "POST", url: `/clubs/code/${open.clubCode}/join`, headers: p1.h });
  assert.equal(j.json().status, "joined");

  const priv = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Private Club", joinMode: "invite_only" } })).json();
  const blocked = await app.inject({ method: "POST", url: `/clubs/code/${priv.clubCode}/join`, headers: p2.h });
  assert.equal(blocked.statusCode, 403);

  // owner invites p2 by their PC- code
  const inv = await app.inject({
    method: "POST", url: `/clubs/${priv.clubId}/invite`, headers: owner.h, payload: { playerCode: p2.code.toLowerCase() },
  });
  assert.equal(inv.statusCode, 200);
  assert.equal(inv.json().displayName, "player_two");

  const myInvites = await app.inject({ method: "GET", url: "/clubs/invites", headers: p2.h });
  assert.equal(myInvites.json()[0].name, "Private Club");
  assert.equal(myInvites.json()[0].invitedBy, "club_owner");

  const now = await app.inject({ method: "POST", url: `/clubs/code/${priv.clubCode}/join`, headers: p2.h });
  assert.equal(now.json().status, "joined");
});

test("roles: owner promotes manager; manager can approve/kick members but not managers", async () => {
  const { app, owner, mgr, p1, p2 } = await setup();
  const club = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Role Club", joinMode: "open" } })).json();
  for (const u of [mgr, p1, p2]) await app.inject({ method: "POST", url: `/clubs/code/${club.clubCode}/join`, headers: u.h });

  // a member cannot promote anyone
  const denied = await app.inject({
    method: "POST", url: `/clubs/${club.clubId}/members/${p1.code}/role`, headers: mgr.h, payload: { role: "manager" },
  });
  assert.equal(denied.statusCode, 403);

  // owner promotes mgr
  const promote = await app.inject({
    method: "POST", url: `/clubs/${club.clubId}/members/${mgr.code}/role`, headers: owner.h, payload: { role: "manager" },
  });
  assert.equal(promote.statusCode, 200);

  // manager kicks a member
  const kick = await app.inject({ method: "DELETE", url: `/clubs/${club.clubId}/members/${p1.code}`, headers: mgr.h });
  assert.equal(kick.statusCode, 200);

  // manager cannot kick owner
  const kickOwner = await app.inject({ method: "DELETE", url: `/clubs/${club.clubId}/members/${owner.code}`, headers: mgr.h });
  assert.equal(kickOwner.statusCode, 403);

  // member list order: owner, manager, members
  const detail = await app.inject({ method: "GET", url: `/clubs/${club.clubId}`, headers: owner.h });
  const roles = detail.json().members.map((m: any) => m.role);
  assert.deepEqual(roles, ["owner", "manager", "member"]);
});

test("owner cannot leave without transferring; transfer flips roles", async () => {
  const { app, owner, p1 } = await setup();
  const club = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Transfer Club", joinMode: "open" } })).json();
  await app.inject({ method: "POST", url: `/clubs/code/${club.clubCode}/join`, headers: p1.h });

  const leave = await app.inject({ method: "POST", url: `/clubs/${club.clubId}/leave`, headers: owner.h });
  assert.equal(leave.statusCode, 403);

  const transfer = await app.inject({
    method: "POST", url: `/clubs/${club.clubId}/transfer`, headers: owner.h, payload: { playerCode: p1.code },
  });
  assert.equal(transfer.statusCode, 200);

  const d = await app.inject({ method: "GET", url: `/clubs/${club.clubId}`, headers: p1.h });
  assert.equal(d.json().yourRole, "owner");
  const old = await app.inject({ method: "GET", url: `/clubs/${club.clubId}`, headers: owner.h });
  assert.equal(old.json().yourRole, "manager");

  // now the old owner can leave
  const leave2 = await app.inject({ method: "POST", url: `/clubs/${club.clubId}/leave`, headers: owner.h });
  assert.equal(leave2.statusCode, 200);
});

test("non-members see only the public card; admin sees every club with owner email", async () => {
  const { app, accounts, owner, p1 } = await setup();
  const club = (await app.inject({ method: "POST", url: "/clubs", headers: owner.h, payload: { name: "Secret Club" } })).json();

  const outsider = await app.inject({ method: "GET", url: `/clubs/${club.clubId}`, headers: p1.h });
  assert.equal(outsider.json().yourRole, null);
  assert.equal(outsider.json().members, undefined);

  const preview = await app.inject({ method: "GET", url: `/clubs/code/${club.clubCode}` });
  assert.equal(preview.json().ownerName, "club_owner");

  const denied = await app.inject({ method: "GET", url: "/admin/clubs", headers: p1.h });
  assert.equal(denied.statusCode, 403);

  (accounts as any).db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run("p1@x.com");
  const all = await app.inject({ method: "GET", url: "/admin/clubs", headers: p1.h });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json()[0].owner.email, "owner@x.com");
  assert.equal(all.json()[0].owner.playerCode, owner.code);
});
