import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { openDb } from "./db.js";
import { AccountService, AccountError, ConsoleMailer, type Mailer } from "./accounts.js";
import { ClubService } from "./clubs.js";
import { TableService } from "./tables.js";
import { attachWebSockets } from "./ws.js";

export interface ServerOptions {
  dbPath?: string;
  jwtSecret: string;
  mailer?: Mailer;
  /** shorter timers for tests */
  actionTimeoutMs?: number;
  nextHandDelayMs?: number;
}

export function buildServer(opts: ServerOptions): { app: FastifyInstance; accounts: AccountService; clubs: ClubService; tables: TableService } {
  const db = openDb(opts.dbPath ?? ":memory:");
  const mailer = opts.mailer ?? new ConsoleMailer();
  const accounts = new AccountService(db, mailer, opts.jwtSecret);
  const clubs = new ClubService(db);
  const tables = new TableService(db, { actionTimeoutMs: opts.actionTimeoutMs, nextHandDelayMs: opts.nextHandDelayMs });

  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.register(cors, { origin: true });
  app.register(fastifyStatic, {
    root: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"),
    prefix: "/",
  });

  // map AccountError -> HTTP
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AccountError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err?.name === "ZodError") {
      return reply.status(400).send({ error: "validation", message: err.issues?.[0]?.message ?? "Invalid input" });
    }
    console.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong" });
  });

  const ctx = (req: any) => ({
    deviceId: req.headers["x-device-id"] as string | undefined,
    ip: req.ip as string,
  });

  // auth guard
  const requireAuth = async (req: any) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new AccountError("unauthorized", "Sign in required", 401);
    req.auth = await accounts.authenticate(token);
  };

  // ---------- signup ----------

  app.post("/auth/signup/begin", async (req) => {
    const body = z.object({
      email: z.string(),
      displayName: z.string(),
      password: z.string().optional(),
    }).parse(req.body);
    return accounts.beginSignup(body);
  });

  app.post("/auth/signup/complete", async (req) => {
    const body = z.object({
      email: z.string(),
      displayName: z.string(),
      code: z.string(),
      password: z.string().optional(),
    }).parse(req.body);
    return accounts.completeSignup({ ...body, ...ctx(req) });
  });

  // ---------- login ----------

  app.post("/auth/login/code/request", async (req) => {
    const body = z.object({ email: z.string() }).parse(req.body);
    return accounts.requestLoginCode(body.email);
  });

  app.post("/auth/login/code/verify", async (req) => {
    const body = z.object({ email: z.string(), code: z.string() }).parse(req.body);
    return accounts.loginWithCode({ ...body, ...ctx(req) });
  });

  app.post("/auth/login/password", async (req) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    return accounts.loginWithPassword({ ...body, ...ctx(req) });
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (req: any) => {
    return accounts.logout(req.headers.authorization.slice(7));
  });

  // ---------- account ----------

  app.get("/me", { preHandler: requireAuth }, async (req: any) => {
    return req.auth.user;
  });

  app.post("/me/password", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    return accounts.setPassword(req.auth.userId, body.password);
  });

  // public profile lookup by player code (for club invites)
  app.get("/players/:code", async (req: any) => {
    const user = accounts.findByPlayerCode(req.params.code);
    if (!user) throw new AccountError("not_found", "Player not found", 404);
    return { playerCode: user.playerCode, displayName: user.displayName };
  });

  // admin-only display name override
  app.post("/admin/players/:code/display-name", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({ displayName: z.string() }).parse(req.body);
    return accounts.adminSetDisplayName(req.auth.userId, req.params.code, body.displayName);
  });

  // ---------- admin: player directory (ID ↔ email ↔ name) ----------

  app.get("/admin/players", { preHandler: requireAuth }, async (req: any) => {
    const q = z.object({
      search: z.string().optional(),
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
    }).parse(req.query ?? {});
    return accounts.adminListPlayers(req.auth.userId, q);
  });

  app.get("/admin/players/export.csv", { preHandler: requireAuth }, async (req: any, reply) => {
    const csv = accounts.adminExportPlayersCsv(req.auth.userId);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="pokercrew-players.csv"');
    return csv;
  });

  app.get("/admin/players/:code", { preHandler: requireAuth }, async (req: any) => {
    return accounts.adminGetPlayer(req.auth.userId, req.params.code);
  });


  // ---------- clubs ----------

  const joinModeSchema = z.enum(["open", "approval", "invite_only"]);

  app.post("/clubs", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({
      name: z.string(),
      description: z.string().optional(),
      joinMode: joinModeSchema.optional(),
    }).parse(req.body);
    return clubs.create(req.auth.userId, body);
  });

  app.get("/clubs/mine", { preHandler: requireAuth }, async (req: any) => clubs.myClubs(req.auth.userId));
  app.get("/clubs/invites", { preHandler: requireAuth }, async (req: any) => clubs.myInvites(req.auth.userId));

  // preview + join by public club code
  app.get("/clubs/code/:code", async (req: any) => clubs.preview(req.params.code));
  app.post("/clubs/code/:code/join", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({ message: z.string().optional() }).parse(req.body ?? {});
    return clubs.join(req.auth.userId, req.params.code, body.message);
  });

  app.get("/clubs/:id", { preHandler: requireAuth }, async (req: any) => clubs.get(req.params.id, req.auth.userId));
  app.patch("/clubs/:id", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      joinMode: joinModeSchema.optional(),
    }).parse(req.body);
    return clubs.update(req.params.id, req.auth.userId, body);
  });
  app.delete("/clubs/:id", { preHandler: requireAuth }, async (req: any) => clubs.delete(req.params.id, req.auth.userId));

  app.get("/clubs/:id/requests", { preHandler: requireAuth }, async (req: any) =>
    clubs.pendingRequests(req.params.id, req.auth.userId));
  app.post("/clubs/:id/requests/:code/approve", { preHandler: requireAuth }, async (req: any) =>
    clubs.approve(req.params.id, req.auth.userId, req.params.code));
  app.post("/clubs/:id/requests/:code/reject", { preHandler: requireAuth }, async (req: any) =>
    clubs.reject(req.params.id, req.auth.userId, req.params.code));

  app.post("/clubs/:id/invite", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({ playerCode: z.string() }).parse(req.body);
    return clubs.invite(req.params.id, req.auth.userId, body.playerCode);
  });

  app.post("/clubs/:id/members/:code/role", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({ role: z.enum(["manager", "member"]) }).parse(req.body);
    return clubs.setRole(req.params.id, req.auth.userId, req.params.code, body.role);
  });
  app.delete("/clubs/:id/members/:code", { preHandler: requireAuth }, async (req: any) =>
    clubs.kick(req.params.id, req.auth.userId, req.params.code));
  app.post("/clubs/:id/leave", { preHandler: requireAuth }, async (req: any) =>
    clubs.leave(req.params.id, req.auth.userId));
  app.post("/clubs/:id/transfer", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({ playerCode: z.string() }).parse(req.body);
    return clubs.transferOwnership(req.params.id, req.auth.userId, body.playerCode);
  });

  app.get("/admin/clubs", { preHandler: requireAuth }, async (req: any) => clubs.adminListClubs(req.auth.userId));


  // ---------- tables ----------

  app.post("/clubs/:id/tables", { preHandler: requireAuth }, async (req: any) => {
    const body = z.object({
      name: z.string().min(1).max(32),
      smallBlind: z.number().int().positive(),
      bigBlind: z.number().int().positive(),
      minBuyin: z.number().int().positive().optional(),
      maxBuyin: z.number().int().positive().optional(),
      maxSeats: z.number().int().optional(),
    }).parse(req.body);
    return tables.create(req.params.id, req.auth.userId, body);
  });

  app.get("/clubs/:id/tables", { preHandler: requireAuth }, async (req: any) =>
    tables.listForClub(req.params.id, req.auth.userId));

  app.get("/tables/:id", { preHandler: requireAuth }, async (req: any) => {
    const t = tables.get(req.params.id);
    return { ...tables.summary(t), state: t.publicState() };
  });

  app.post("/tables/:id/close", { preHandler: requireAuth }, async (req: any) =>
    tables.close(req.params.id, req.auth.userId));

  // ---------- admin: rake dashboard (owner only) ----------

  const rangeQ = z.object({ from: z.string().optional(), to: z.string().optional() });

  app.get("/admin/rake/summary", { preHandler: requireAuth }, async (req: any) => {
    const q = rangeQ.parse(req.query ?? {});
    return tables.adminRakeSummary(req.auth.userId, q.from, q.to);
  });
  app.get("/admin/rake/by-club", { preHandler: requireAuth }, async (req: any) => {
    const q = rangeQ.parse(req.query ?? {});
    return tables.adminRakeByClub(req.auth.userId, q.from, q.to);
  });
  app.get("/admin/rake/by-table", { preHandler: requireAuth }, async (req: any) => {
    const q = rangeQ.extend({ clubId: z.string().optional() }).parse(req.query ?? {});
    return tables.adminRakeByTable(req.auth.userId, q.clubId, q.from, q.to);
  });
  app.get("/admin/rake/daily", { preHandler: requireAuth }, async (req: any) => {
    const q = z.object({ days: z.coerce.number().int().optional() }).parse(req.query ?? {});
    return tables.adminRakeDaily(req.auth.userId, q.days);
  });

  app.get("/health", async () => ({ ok: true }));

  // WebSockets share the same HTTP server (path /ws)
  let wss: ReturnType<typeof attachWebSockets> | null = null;
  app.addHook("onReady", async () => { wss = attachWebSockets(app.server, accounts, tables); });
  app.addHook("onClose", async () => {
    tables.closeAll();
    if (wss) {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss!.close(() => r()));
    }
  });

  return { app, accounts, clubs, tables };
}

// run directly: `npx tsx src/server.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app } = buildServer({
    dbPath: process.env.DB_PATH ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH ? process.env.RAILWAY_VOLUME_MOUNT_PATH + "/pokercrew.db" : "./pokercrew.db"),
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    console.log(`PokerCrew server listening on http://localhost:${port}`);
  });
}
