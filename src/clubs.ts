import type { DatabaseSync } from "node:sqlite";
import { randomInt } from "node:crypto";
import { nowIso } from "./db.js";
import { generateId } from "./ids.js";
import { AccountError } from "./accounts.js";

export type ClubRole = "owner" | "manager" | "member";
export type JoinMode = "open" | "approval" | "invite_only";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function clubCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return `CL-${s}`;
}

const NAME_RE = /^[\w][\w \-'.]{2,31}$/;
const MAX_CLUBS_OWNED = 5;

export class ClubService {
  constructor(private db: DatabaseSync) {}

  // ---------- helpers ----------

  private club(clubId: string): any {
    const row = this.db.prepare("SELECT * FROM clubs WHERE id = ?").get(clubId);
    if (!row) throw new AccountError("not_found", "Club not found", 404);
    return row;
  }

  private clubByCode(code: string): any {
    const row = this.db
      .prepare("SELECT * FROM clubs WHERE club_code = ?")
      .get(code.trim().toUpperCase());
    if (!row) throw new AccountError("not_found", "Club not found", 404);
    return row;
  }

  private userByPlayerCode(code: string): any {
    const row = this.db
      .prepare("SELECT * FROM users WHERE player_code = ?")
      .get(code.trim().toUpperCase());
    if (!row) throw new AccountError("not_found", "Player not found", 404);
    return row;
  }

  roleOf(clubId: string, userId: string): ClubRole | null {
    const row = this.db
      .prepare("SELECT role FROM club_members WHERE club_id = ? AND user_id = ?")
      .get(clubId, userId) as any;
    return row ? (row.role as ClubRole) : null;
  }

  private requireRole(clubId: string, userId: string, allowed: ClubRole[]) {
    const role = this.roleOf(clubId, userId);
    if (!role || !allowed.includes(role)) {
      throw new AccountError("forbidden", "You don't have permission to do that in this club", 403);
    }
    return role;
  }

  private isAdmin(userId: string): boolean {
    const row = this.db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as any;
    return row?.role === "admin";
  }

  private toClub(row: any, memberCount?: number) {
    return {
      clubId: row.id,
      clubCode: row.club_code,
      name: row.name,
      description: row.description ?? "",
      joinMode: row.join_mode as JoinMode,
      createdAt: row.created_at,
      memberCount: memberCount ?? this.memberCount(row.id),
    };
  }

  private memberCount(clubId: string): number {
    return (this.db
      .prepare("SELECT COUNT(*) AS n FROM club_members WHERE club_id = ?")
      .get(clubId) as any).n;
  }

  private addMember(clubId: string, userId: string, role: ClubRole) {
    this.db
      .prepare(
        `INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(club_id, user_id) DO NOTHING`
      )
      .run(clubId, userId, role, nowIso());
    this.db.prepare("DELETE FROM club_join_requests WHERE club_id = ? AND user_id = ?").run(clubId, userId);
    this.db.prepare("DELETE FROM club_invites WHERE club_id = ? AND user_id = ?").run(clubId, userId);
  }

  // ---------- create / read ----------

  create(ownerId: string, input: { name: string; description?: string; joinMode?: JoinMode }) {
    if (!NAME_RE.test(input.name)) {
      throw new AccountError("invalid_name", "Club name must be 3–32 characters");
    }
    const owned = (this.db
      .prepare("SELECT COUNT(*) AS n FROM clubs WHERE owner_id = ?")
      .get(ownerId) as any).n;
    if (owned >= MAX_CLUBS_OWNED) {
      throw new AccountError("limit", `You can own at most ${MAX_CLUBS_OWNED} clubs`);
    }

    let code = clubCode();
    while (this.db.prepare("SELECT 1 FROM clubs WHERE club_code = ?").get(code)) code = clubCode();

    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO clubs (id, club_code, name, description, owner_id, join_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, code, input.name.trim(), input.description?.trim() ?? null, ownerId,
        input.joinMode ?? "approval", nowIso());
    this.addMember(id, ownerId, "owner");
    return this.toClub(this.club(id), 1);
  }

  get(clubId: string, viewerId: string) {
    const row = this.club(clubId);
    const role = this.roleOf(clubId, viewerId);
    if (!role && !this.isAdmin(viewerId)) {
      // non-members see a minimal public card
      return { ...this.toClub(row), yourRole: null, members: undefined };
    }
    return { ...this.toClub(row), yourRole: role, members: this.members(clubId) };
  }

  /** Public preview by join code (for the "join a club" screen). */
  preview(clubCode: string) {
    const row = this.clubByCode(clubCode);
    const owner = this.db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.owner_id) as any;
    return { ...this.toClub(row), ownerName: owner.display_name };
  }

  members(clubId: string) {
    return (this.db
      .prepare(
        `SELECT u.player_code, u.display_name, m.role, m.joined_at
         FROM club_members m JOIN users u ON u.id = m.user_id
         WHERE m.club_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.joined_at`
      )
      .all(clubId) as any[]).map((r) => ({
        playerCode: r.player_code,
        displayName: r.display_name,
        role: r.role as ClubRole,
        joinedAt: r.joined_at,
      }));
  }

  myClubs(userId: string) {
    return (this.db
      .prepare(
        `SELECT c.*, m.role,
                (SELECT COUNT(*) FROM club_members x WHERE x.club_id = c.id) AS n
         FROM club_members m JOIN clubs c ON c.id = m.club_id
         WHERE m.user_id = ? ORDER BY m.joined_at`
      )
      .all(userId) as any[]).map((r) => ({ ...this.toClub(r, r.n), yourRole: r.role as ClubRole }));
  }

  update(clubId: string, actorId: string, patch: { name?: string; description?: string; joinMode?: JoinMode }) {
    this.requireRole(clubId, actorId, ["owner"]);
    if (patch.name !== undefined && !NAME_RE.test(patch.name)) {
      throw new AccountError("invalid_name", "Club name must be 3–32 characters");
    }
    const row = this.club(clubId);
    this.db
      .prepare("UPDATE clubs SET name = ?, description = ?, join_mode = ? WHERE id = ?")
      .run(
        patch.name?.trim() ?? row.name,
        patch.description !== undefined ? patch.description.trim() : row.description,
        patch.joinMode ?? row.join_mode,
        clubId
      );
    return this.toClub(this.club(clubId));
  }

  // ---------- joining ----------

  /** Player asks to join via club code. Behaviour depends on join_mode. */
  join(userId: string, clubCode: string, message?: string) {
    const club = this.clubByCode(clubCode);
    if (this.roleOf(club.id, userId)) {
      throw new AccountError("already_member", "You're already in this club", 409);
    }
    const invited = this.db
      .prepare("SELECT 1 FROM club_invites WHERE club_id = ? AND user_id = ?")
      .get(club.id, userId);

    if (club.join_mode === "open" || invited) {
      this.addMember(club.id, userId, "member");
      return { status: "joined" as const, club: this.toClub(club) };
    }
    if (club.join_mode === "invite_only") {
      throw new AccountError("invite_only", "This club is invite-only", 403);
    }
    // approval
    this.db
      .prepare(
        `INSERT INTO club_join_requests (club_id, user_id, message, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(club_id, user_id) DO UPDATE SET message = excluded.message, created_at = excluded.created_at`
      )
      .run(club.id, userId, message ?? null, nowIso());
    return { status: "pending" as const, club: this.toClub(club) };
  }

  pendingRequests(clubId: string, actorId: string) {
    this.requireRole(clubId, actorId, ["owner", "manager"]);
    return (this.db
      .prepare(
        `SELECT u.player_code, u.display_name, r.message, r.created_at
         FROM club_join_requests r JOIN users u ON u.id = r.user_id
         WHERE r.club_id = ? ORDER BY r.created_at`
      )
      .all(clubId) as any[]).map((r) => ({
        playerCode: r.player_code, displayName: r.display_name,
        message: r.message ?? "", requestedAt: r.created_at,
      }));
  }

  approve(clubId: string, actorId: string, playerCode: string) {
    this.requireRole(clubId, actorId, ["owner", "manager"]);
    const user = this.userByPlayerCode(playerCode);
    const req = this.db
      .prepare("SELECT 1 FROM club_join_requests WHERE club_id = ? AND user_id = ?")
      .get(clubId, user.id);
    if (!req) throw new AccountError("not_found", "No pending request from that player", 404);
    this.addMember(clubId, user.id, "member");
    return { ok: true };
  }

  reject(clubId: string, actorId: string, playerCode: string) {
    this.requireRole(clubId, actorId, ["owner", "manager"]);
    const user = this.userByPlayerCode(playerCode);
    this.db.prepare("DELETE FROM club_join_requests WHERE club_id = ? AND user_id = ?").run(clubId, user.id);
    return { ok: true };
  }

  /** Owner/manager invites a player by their PC- code. They can then join even if invite-only. */
  invite(clubId: string, actorId: string, playerCode: string) {
    this.requireRole(clubId, actorId, ["owner", "manager"]);
    const user = this.userByPlayerCode(playerCode);
    if (this.roleOf(clubId, user.id)) {
      throw new AccountError("already_member", "That player is already a member", 409);
    }
    this.db
      .prepare(
        `INSERT INTO club_invites (club_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(club_id, user_id) DO NOTHING`
      )
      .run(clubId, user.id, actorId, nowIso());
    return { ok: true, playerCode: user.player_code, displayName: user.display_name };
  }

  myInvites(userId: string) {
    return (this.db
      .prepare(
        `SELECT c.*, u.display_name AS inviter,
                (SELECT COUNT(*) FROM club_members x WHERE x.club_id = c.id) AS n
         FROM club_invites i JOIN clubs c ON c.id = i.club_id JOIN users u ON u.id = i.invited_by
         WHERE i.user_id = ? ORDER BY i.created_at DESC`
      )
      .all(userId) as any[]).map((r) => ({ ...this.toClub(r, r.n), invitedBy: r.inviter }));
  }

  // ---------- management ----------

  setRole(clubId: string, actorId: string, playerCode: string, role: "manager" | "member") {
    this.requireRole(clubId, actorId, ["owner"]);
    const user = this.userByPlayerCode(playerCode);
    const current = this.roleOf(clubId, user.id);
    if (!current) throw new AccountError("not_found", "That player is not a member", 404);
    if (current === "owner") throw new AccountError("forbidden", "Cannot change the owner's role", 403);
    this.db
      .prepare("UPDATE club_members SET role = ? WHERE club_id = ? AND user_id = ?")
      .run(role, clubId, user.id);
    return { ok: true };
  }

  kick(clubId: string, actorId: string, playerCode: string) {
    const actorRole = this.requireRole(clubId, actorId, ["owner", "manager"]);
    const user = this.userByPlayerCode(playerCode);
    const target = this.roleOf(clubId, user.id);
    if (!target) throw new AccountError("not_found", "That player is not a member", 404);
    if (target === "owner") throw new AccountError("forbidden", "Cannot remove the owner", 403);
    if (target === "manager" && actorRole !== "owner") {
      throw new AccountError("forbidden", "Only the owner can remove a manager", 403);
    }
    this.db.prepare("DELETE FROM club_members WHERE club_id = ? AND user_id = ?").run(clubId, user.id);
    return { ok: true };
  }

  leave(clubId: string, userId: string) {
    const role = this.roleOf(clubId, userId);
    if (!role) throw new AccountError("not_found", "You're not in this club", 404);
    if (role === "owner") {
      throw new AccountError("forbidden", "Transfer ownership or delete the club before leaving", 403);
    }
    this.db.prepare("DELETE FROM club_members WHERE club_id = ? AND user_id = ?").run(clubId, userId);
    return { ok: true };
  }

  transferOwnership(clubId: string, actorId: string, playerCode: string) {
    this.requireRole(clubId, actorId, ["owner"]);
    const user = this.userByPlayerCode(playerCode);
    if (!this.roleOf(clubId, user.id)) {
      throw new AccountError("not_found", "New owner must already be a member", 404);
    }
    this.db.prepare("UPDATE club_members SET role = 'manager' WHERE club_id = ? AND user_id = ?").run(clubId, actorId);
    this.db.prepare("UPDATE club_members SET role = 'owner' WHERE club_id = ? AND user_id = ?").run(clubId, user.id);
    this.db.prepare("UPDATE clubs SET owner_id = ? WHERE id = ?").run(user.id, clubId);
    return { ok: true };
  }

  delete(clubId: string, actorId: string) {
    if (!this.isAdmin(actorId)) this.requireRole(clubId, actorId, ["owner"]);
    this.db.prepare("DELETE FROM clubs WHERE id = ?").run(clubId);
    return { ok: true };
  }

  // ---------- admin ----------

  adminListClubs(actorId: string) {
    if (!this.isAdmin(actorId)) throw new AccountError("forbidden", "Admin access required", 403);
    return (this.db
      .prepare(
        `SELECT c.*, u.player_code AS owner_code, u.email AS owner_email, u.display_name AS owner_name,
                (SELECT COUNT(*) FROM club_members x WHERE x.club_id = c.id) AS n
         FROM clubs c JOIN users u ON u.id = c.owner_id ORDER BY c.created_at`
      )
      .all() as any[]).map((r) => ({
        ...this.toClub(r, r.n),
        owner: { playerCode: r.owner_code, email: r.owner_email, displayName: r.owner_name },
      }));
  }
}
