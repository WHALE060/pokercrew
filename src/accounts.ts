import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, plusMinutes, plusDays } from "./db.js";
import { generateId, generatePlayerCode, generateOtp } from "./ids.js";

export interface PublicUser {
  playerCode: string;
  displayName: string;
  email: string;
  role: string;
  chips: number;
  createdAt: string;
  hasPassword: boolean;
}

export interface Mailer {
  sendOtp(email: string, code: string, purpose: "login" | "signup"): Promise<void>;
}

/** Dev mailer: just logs. Swap for a real provider (Resend, Postmark, SES) in prod. */
export class ConsoleMailer implements Mailer {
  public sent: { email: string; code: string; purpose: string }[] = [];
  async sendOtp(email: string, code: string, purpose: "login" | "signup") {
    this.sent.push({ email, code, purpose });
    console.log(`[mail] ${purpose} code for ${email}: ${code}`);
  }
}

export class AccountError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const DISPLAY_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_DAYS = 30;
const STARTING_CHIPS = 10_000;

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class AccountService {
  private jwtKey: Uint8Array;

  constructor(
    private db: DatabaseSync,
    private mailer: Mailer,
    jwtSecret: string
  ) {
    this.jwtKey = new TextEncoder().encode(jwtSecret);
  }

  // ---------- helpers ----------

  private rowToUser(row: any): PublicUser {
    return {
      playerCode: row.player_code,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      chips: row.chips,
      createdAt: row.created_at,
      hasPassword: !!row.password_hash,
    };
  }

  private findByEmail(email: string): any | undefined {
    return this.db.prepare("SELECT * FROM users WHERE email = ?").get(normEmail(email));
  }

  findByPlayerCode(code: string): PublicUser | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE player_code = ?")
      .get(code.trim().toUpperCase());
    return row ? this.rowToUser(row) : null;
  }

  private uniquePlayerCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = generatePlayerCode();
      const exists = this.db.prepare("SELECT 1 FROM users WHERE player_code = ?").get(code);
      if (!exists) return code;
    }
    throw new AccountError("code_gen_failed", "Could not allocate player code", 500);
  }

  // ---------- signup ----------

  /**
   * Step 1 of signup: validate inputs and email a code.
   * Nothing is created until the code is verified.
   */
  async beginSignup(input: { email: string; displayName: string; password?: string }) {
    const email = normEmail(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AccountError("invalid_email", "Enter a valid email address");
    }
    if (!DISPLAY_NAME_RE.test(input.displayName)) {
      throw new AccountError(
        "invalid_display_name",
        "Display name must be 3–16 characters: letters, numbers, underscore"
      );
    }
    if (this.findByEmail(email)) {
      throw new AccountError("email_taken", "An account with this email already exists", 409);
    }
    const nameTaken = this.db
      .prepare("SELECT 1 FROM users WHERE display_name = ? COLLATE NOCASE")
      .get(input.displayName);
    if (nameTaken) {
      throw new AccountError("display_name_taken", "That display name is taken", 409);
    }
    if (input.password !== undefined && input.password.length < 8) {
      throw new AccountError("weak_password", "Password must be at least 8 characters");
    }

    await this.issueOtp(email, "signup");
    return { email };
  }

  /**
   * Step 2 of signup: verify the code and create the account.
   * The display name is locked from this moment on.
   */
  async completeSignup(input: {
    email: string;
    displayName: string;
    code: string;
    password?: string;
    deviceId?: string;
    ip?: string;
  }) {
    const email = normEmail(input.email);
    this.verifyOtp(email, "signup", input.code);

    // re-check uniqueness (race safety)
    if (this.findByEmail(email)) {
      throw new AccountError("email_taken", "An account with this email already exists", 409);
    }

    const id = generateId();
    const playerCode = this.uniquePlayerCode();
    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;

    this.db
      .prepare(
        `INSERT INTO users (id, player_code, email, display_name, password_hash, chips, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, playerCode, email, input.displayName, passwordHash, STARTING_CHIPS, nowIso(), nowIso());

    const token = await this.createSession(id, input.deviceId, input.ip);
    return { user: this.findByPlayerCode(playerCode)!, token };
  }

  // ---------- login: one-time code ----------

  async requestLoginCode(email: string) {
    const user = this.findByEmail(email);
    // Don't reveal whether the email exists; only send if it does.
    if (user) await this.issueOtp(normEmail(email), "login");
    return { ok: true };
  }

  async loginWithCode(input: { email: string; code: string; deviceId?: string; ip?: string }) {
    const email = normEmail(input.email);
    const user = this.findByEmail(email);
    if (!user) throw new AccountError("invalid_code", "Invalid or expired code", 401);
    this.verifyOtp(email, "login", input.code);
    return this.finishLogin(user, input.deviceId, input.ip);
  }

  // ---------- login: password ----------

  async loginWithPassword(input: { email: string; password: string; deviceId?: string; ip?: string }) {
    const user = this.findByEmail(input.email);
    if (!user || !user.password_hash) {
      throw new AccountError("invalid_credentials", "Email or password is incorrect", 401);
    }
    const ok = await bcrypt.compare(input.password, user.password_hash);
    if (!ok) throw new AccountError("invalid_credentials", "Email or password is incorrect", 401);
    return this.finishLogin(user, input.deviceId, input.ip);
  }

  /** Let a passwordless user add a password later (must be logged in). */
  async setPassword(userId: string, password: string) {
    if (password.length < 8) {
      throw new AccountError("weak_password", "Password must be at least 8 characters");
    }
    const hash = await bcrypt.hash(password, 10);
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
    return { ok: true };
  }

  private async finishLogin(user: any, deviceId?: string, ip?: string) {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
    const token = await this.createSession(user.id, deviceId, ip);
    return { user: this.rowToUser(user), token };
  }

  // ---------- display name lock ----------

  /**
   * Display names are permanent. Players cannot change them.
   * Only an admin may override, and the change is recorded via the caller.
   */
  adminSetDisplayName(adminUserId: string, targetPlayerCode: string, newName: string) {
    const admin = this.db.prepare("SELECT role FROM users WHERE id = ?").get(adminUserId) as any;
    if (!admin || admin.role !== "admin") {
      throw new AccountError("forbidden", "Only an admin can change display names", 403);
    }
    if (!DISPLAY_NAME_RE.test(newName)) {
      throw new AccountError("invalid_display_name", "Invalid display name");
    }
    const res = this.db
      .prepare("UPDATE users SET display_name = ? WHERE player_code = ?")
      .run(newName, targetPlayerCode.toUpperCase());
    if (res.changes === 0) throw new AccountError("not_found", "Player not found", 404);
    return { ok: true };
  }

  // ---------- admin: player directory ----------

  private assertAdmin(userId: string) {
    const admin = this.db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as any;
    if (!admin || admin.role !== "admin") {
      throw new AccountError("forbidden", "Admin access required", 403);
    }
  }

  /**
   * Full player directory: player code ↔ email ↔ display name, plus activity.
   * Admin only. Supports search by code / email / name and pagination.
   */
  adminListPlayers(adminUserId: string, opts: { search?: string; limit?: number; offset?: number } = {}) {
    this.assertAdmin(adminUserId);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const like = opts.search ? `%${opts.search.trim()}%` : null;

    const where = like ? "WHERE player_code LIKE ? OR email LIKE ? OR display_name LIKE ?" : "";
    const params = like ? [like, like, like] : [];

    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM users ${where}`)
      .get(...params) as any).n as number;

    const rows = this.db
      .prepare(
        `SELECT player_code, email, display_name, role, chips, created_at, last_login_at,
                CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password
         FROM users ${where}
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as any[];

    return {
      total,
      limit,
      offset,
      players: rows.map((r) => ({
        playerCode: r.player_code,
        email: r.email,
        displayName: r.display_name,
        role: r.role,
        chips: r.chips,
        hasPassword: !!r.has_password,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      })),
    };
  }

  /** Everything about one player, including their sessions/devices. Admin only. */
  adminGetPlayer(adminUserId: string, playerCode: string) {
    this.assertAdmin(adminUserId);
    const row = this.db
      .prepare("SELECT * FROM users WHERE player_code = ?")
      .get(playerCode.trim().toUpperCase()) as any;
    if (!row) throw new AccountError("not_found", "Player not found", 404);
    const sessions = this.db
      .prepare(
        `SELECT device_id, ip, created_at, expires_at, revoked
         FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(row.id) as any[];
    return {
      playerCode: row.player_code,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      chips: row.chips,
      hasPassword: !!row.password_hash,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      sessions: sessions.map((s) => ({
        deviceId: s.device_id,
        ip: s.ip,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        revoked: !!s.revoked,
      })),
    };
  }

  /** CSV export of the whole directory. Admin only. */
  adminExportPlayersCsv(adminUserId: string): string {
    this.assertAdmin(adminUserId);
    const rows = this.db
      .prepare(
        `SELECT player_code, email, display_name, role, chips, created_at, last_login_at
         FROM users ORDER BY created_at ASC`
      )
      .all() as any[];
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = "player_code,email,display_name,role,chips,created_at,last_login_at";
    const lines = rows.map((r) =>
      [r.player_code, r.email, r.display_name, r.role, r.chips, r.created_at, r.last_login_at]
        .map(esc).join(",")
    );
    return [header, ...lines].join("\n");
  }

  // ---------- OTP internals ----------

  private async issueOtp(email: string, purpose: "login" | "signup") {
    const code = generateOtp();
    this.db
      .prepare(
        `INSERT INTO otp_codes (email, code_hash, purpose, expires_at, attempts, created_at)
         VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(email, purpose) DO UPDATE SET
           code_hash = excluded.code_hash,
           expires_at = excluded.expires_at,
           attempts = 0,
           created_at = excluded.created_at`
      )
      .run(email, sha256(code), purpose, plusMinutes(OTP_TTL_MIN), nowIso());
    await this.mailer.sendOtp(email, code, purpose);
  }

  private verifyOtp(email: string, purpose: "login" | "signup", code: string) {
    const row = this.db
      .prepare("SELECT * FROM otp_codes WHERE email = ? AND purpose = ?")
      .get(email, purpose) as any;
    if (!row) throw new AccountError("invalid_code", "Invalid or expired code", 401);
    if (new Date(row.expires_at) < new Date()) {
      this.db.prepare("DELETE FROM otp_codes WHERE email = ? AND purpose = ?").run(email, purpose);
      throw new AccountError("invalid_code", "Invalid or expired code", 401);
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      this.db.prepare("DELETE FROM otp_codes WHERE email = ? AND purpose = ?").run(email, purpose);
      throw new AccountError("too_many_attempts", "Too many attempts. Request a new code", 429);
    }
    if (row.code_hash !== sha256(code.trim())) {
      this.db
        .prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?")
        .run(email, purpose);
      throw new AccountError("invalid_code", "Invalid or expired code", 401);
    }
    this.db.prepare("DELETE FROM otp_codes WHERE email = ? AND purpose = ?").run(email, purpose);
  }

  // ---------- sessions / JWT ----------

  private async createSession(userId: string, deviceId?: string, ip?: string): Promise<string> {
    const sessionId = generateId();
    const expiresAt = plusDays(SESSION_DAYS);
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, device_id, ip, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, userId, deviceId ?? null, ip ?? null, nowIso(), expiresAt);

    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${SESSION_DAYS}d`)
      .sign(this.jwtKey);
  }

  async authenticate(token: string): Promise<{ userId: string; user: PublicUser }> {
    let payload: any;
    try {
      ({ payload } = await jwtVerify(token, this.jwtKey));
    } catch {
      throw new AccountError("unauthorized", "Invalid or expired session", 401);
    }
    const session = this.db
      .prepare("SELECT * FROM sessions WHERE id = ? AND revoked = 0")
      .get(payload.sid) as any;
    if (!session || new Date(session.expires_at) < new Date()) {
      throw new AccountError("unauthorized", "Invalid or expired session", 401);
    }
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub) as any;
    if (!row) throw new AccountError("unauthorized", "Account not found", 401);
    return { userId: row.id, user: this.rowToUser(row) };
  }

  logout(token: string) {
    // decode without verifying signature isn't safe; verify first
    return jwtVerify(token, this.jwtKey)
      .then(({ payload }) => {
        this.db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(payload.sid as string);
        return { ok: true };
      })
      .catch(() => ({ ok: true }));
  }
}
