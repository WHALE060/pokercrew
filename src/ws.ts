import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { AccountService } from "./accounts.js";
import type { TableService, LiveTable } from "./tables.js";
import { AccountError } from "./accounts.js";

/**
 * Protocol (JSON messages):
 *
 * client -> server
 *   { type: "auth",  token }
 *   { type: "join",  tableId }                 // spectate + receive state
 *   { type: "sit",   seat, buyIn }
 *   { type: "leave" }                          // stand up (cash out)
 *   { type: "act",   action, amount? }         // fold|check|call|bet|raise|allin
 *   { type: "ping" }
 *
 * server -> client
 *   { type: "authed", user }
 *   { type: "state",  table, you }             // you = { holeCards, legalActions }
 *   { type: "hand_started", handNo }
 *   { type: "hand_complete", handNo, board, winners, showdown }
 *   { type: "error", code, message }
 *   { type: "pong" }
 */

interface Client {
  ws: WebSocket;
  userId?: string;
  user?: { playerCode: string; displayName: string };
  tableId?: string;
}

export function attachWebSockets(
  httpServer: HttpServer,
  accounts: AccountService,
  tables: TableService
) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const clientsByTable = new Map<string, Set<Client>>();
  const wired = new Set<string>();

  const send = (c: Client, msg: any) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const sendError = (c: Client, err: any) => {
    if (err instanceof AccountError) return send(c, { type: "error", code: err.code, message: err.message });
    send(c, { type: "error", code: "error", message: err?.message ?? "Something went wrong" });
  };

  const broadcastState = (t: LiveTable) => {
    const pub = t.publicState();
    for (const c of clientsByTable.get(t.row.id) ?? []) {
      send(c, { type: "state", table: pub, you: c.userId ? t.privateState(c.userId) : null });
    }
  };

  /** Hook table events once per live table. */
  const wireTable = (t: LiveTable) => {
    if (wired.has(t.row.id)) return;
    wired.add(t.row.id);
    t.on("state", () => broadcastState(t));
    t.on("hand_started", (e) => {
      for (const c of clientsByTable.get(t.row.id) ?? []) send(c, { type: "hand_started", ...e });
    });
    t.on("hand_complete", (e) => {
      for (const c of clientsByTable.get(t.row.id) ?? []) send(c, { type: "hand_complete", ...e });
    });
    t.on("closed", () => {
      for (const c of clientsByTable.get(t.row.id) ?? []) send(c, { type: "table_closed" });
      clientsByTable.delete(t.row.id);
      wired.delete(t.row.id);
    });
  };

  wss.on("connection", (ws) => {
    const client: Client = { ws };

    ws.on("message", async (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return sendError(client, new AccountError("bad_json", "Invalid JSON")); }

      try {
        switch (msg.type) {
          case "ping":
            return send(client, { type: "pong" });

          case "auth": {
            const { userId, user } = await accounts.authenticate(String(msg.token ?? ""));
            client.userId = userId;
            client.user = { playerCode: user.playerCode, displayName: user.displayName };
            return send(client, { type: "authed", user: client.user });
          }

          case "join": {
            requireAuth(client);
            const t = tables.get(String(msg.tableId));
            wireTable(t);
            if (client.tableId && client.tableId !== t.row.id) leaveRoom(client);
            client.tableId = t.row.id;
            if (!clientsByTable.has(t.row.id)) clientsByTable.set(t.row.id, new Set());
            clientsByTable.get(t.row.id)!.add(client);
            t.setConnected(client.userId!, true);
            return send(client, { type: "state", table: t.publicState(), you: t.privateState(client.userId!) });
          }

          case "sit": {
            const t = requireTable(client);
            tables.assertCanSit(t.row.id, client.userId!);
            t.sit(
              { id: client.userId!, playerCode: client.user!.playerCode, displayName: client.user!.displayName },
              Number(msg.seat), Number(msg.buyIn)
            );
            return;
          }

          case "leave": {
            const t = requireTable(client);
            t.leave(client.userId!);
            return;
          }

          case "act": {
            const t = requireTable(client);
            t.act(client.userId!, String(msg.action) as any, Number(msg.amount ?? 0));
            return;
          }

          default:
            return sendError(client, new AccountError("unknown_type", `Unknown message type: ${msg.type}`));
        }
      } catch (err) {
        sendError(client, err);
      }
    });

    ws.on("close", () => {
      if (client.tableId) {
        // mark disconnected; they keep their seat and get auto-folded by the timer
        const t = tables.peek(client.tableId);
        if (t && client.userId) t.setConnected(client.userId, false);
        leaveRoom(client);
      }
    });
  });

  function requireAuth(c: Client) {
    if (!c.userId) throw new AccountError("unauthorized", "Send auth first", 401);
  }
  function requireTable(c: Client): LiveTable {
    requireAuth(c);
    if (!c.tableId) throw new AccountError("no_table", "Join a table first");
    return tables.get(c.tableId);
  }
  function leaveRoom(c: Client) {
    if (!c.tableId) return;
    clientsByTable.get(c.tableId)?.delete(c);
    c.tableId = undefined;
  }

  return wss;
}
