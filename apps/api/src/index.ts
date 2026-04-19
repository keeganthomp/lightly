/**
 * Lightly API — Hono on Bun.
 *
 * HTTP:
 *   GET  /health
 *   GET  /tables                  list active tables
 *   POST /tables                  operator-only (for now, auth by API key)
 *   GET  /tables/:id              current snapshot
 *   POST /auth/nonce              SIWS nonce
 *   POST /auth/verify             SIWS signature verify → session cookie
 *
 * WS:
 *   /ws/:tableId                  streaming TableView + action channel
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ServerWebSocket } from "bun";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { zAction, type ServerEvent } from "@lightly/shared";
import { HoldemEngine, type HandOutcome, type TableConfig } from "./engine.ts";

const app = new Hono();
app.use("*", cors({ origin: "*", credentials: true }));

// ---------- In-memory state (replace with Postgres for persistence) ----------

type TableEntry = {
  config: TableConfig;
  engine: HoldemEngine;
  sockets: Set<ServerWebSocket<SocketData>>;
  mint: string;
  onchainTableId: bigint;
};
const tables = new Map<string, TableEntry>();
const nonces = new Map<string, { nonce: string; expiresAt: number }>();

type SocketData = { tableId: string; wallet: string };

// ---------- Health ----------

app.get("/health", (c) => c.json({ ok: true, tables: tables.size }));

// ---------- Tables ----------

app.get("/tables", (c) =>
  c.json(
    [...tables.values()].map((t) => ({
      tableId: t.config.tableId,
      onchainTableId: String(t.onchainTableId),
      mint: t.mint,
      smallBlind: t.config.smallBlind,
      bigBlind: t.config.bigBlind,
      maxSeats: t.config.maxSeats,
      seatsTaken: t.engine.activeSeats().length,
    })),
  ),
);

app.get("/tables/:id", (c) => {
  const id = c.req.param("id");
  const table = tables.get(id);
  if (!table) throw new HTTPException(404, { message: "table not found" });
  return c.json(table.engine.view(""));
});

// Operator-only in dev — API key guard. In prod this is a Squads-signed tx, not a POST.
app.post("/tables", async (c) => {
  const key = c.req.header("x-api-key");
  if (key !== (process.env.OPERATOR_API_KEY ?? "dev-secret")) {
    throw new HTTPException(401);
  }
  const body = await c.req.json();
  const config: TableConfig = {
    tableId: body.tableId ?? crypto.randomUUID(),
    maxSeats: body.maxSeats ?? 6,
    smallBlind: body.smallBlind ?? 100_000,
    bigBlind: body.bigBlind ?? 200_000,
    minBuyIn: body.minBuyIn ?? 10_000_000,
    maxBuyIn: body.maxBuyIn ?? 1_000_000_000,
    rakeBps: body.rakeBps ?? 250,
    actionTimeoutMs: body.actionTimeoutMs ?? 30_000,
  };
  createTableEntry(config, body.mint ?? "", BigInt(body.onchainTableId ?? 0));
  return c.json({ tableId: config.tableId });
});

function createTableEntry(config: TableConfig, mint: string, onchainTableId: bigint): TableEntry {
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const emit = (event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      try { ws.send(payload); } catch { /* broken socket */ }
    }
  };
  const engine = new HoldemEngine({
    config,
    randomSeed: () => {
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      return buf;
    },
    emit,
    onHandComplete: (outcome: HandOutcome) => {
      // In prod: submit begin_hand + settle_hand on-chain here (settlement worker).
      // For MVP we emit the synthetic `settled` event immediately with a stub sig.
      emit({
        kind: "settled",
        winners: outcome.winners,
        rake: outcome.rake,
        txSig: `stub-${outcome.handId}`,
      });
    },
  });
  const entry: TableEntry = { config, engine, sockets, mint, onchainTableId };
  tables.set(config.tableId, entry);
  return entry;
}

// Dev-only demo table so `bun dev` is playable without operator setup.
if (!tables.size) {
  createTableEntry(
    {
      tableId: "demo",
      maxSeats: 6,
      smallBlind: 100_000,
      bigBlind: 200_000,
      minBuyIn: 10_000_000,
      maxBuyIn: 1_000_000_000,
      rakeBps: 250,
      actionTimeoutMs: 30_000,
    },
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    1n,
  );
}

// ---------- SIWS auth ----------

app.post("/auth/nonce", async (c) => {
  const body = await c.req.json();
  const wallet = z_wallet(body.wallet);
  const nonce = crypto.randomUUID();
  nonces.set(wallet, { nonce, expiresAt: Date.now() + 5 * 60_000 });
  return c.json({ nonce, message: siwsMessage(wallet, nonce) });
});

app.post("/auth/verify", async (c) => {
  const body = await c.req.json();
  const wallet = z_wallet(body.wallet);
  const entry = nonces.get(wallet);
  if (!entry || entry.expiresAt < Date.now()) {
    throw new HTTPException(400, { message: "nonce expired" });
  }
  const message = siwsMessage(wallet, entry.nonce);
  const sig = Uint8Array.from(Buffer.from(body.signature, "base64"));
  const pub = new PublicKey(wallet).toBytes();
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  if (!ok) throw new HTTPException(401, { message: "bad signature" });
  nonces.delete(wallet);
  // MVP: return the wallet as the session ID. Replace with JWT in prod.
  return c.json({ sessionId: wallet });
});

function z_wallet(s: unknown): string {
  if (typeof s !== "string") throw new HTTPException(400, { message: "wallet string required" });
  try { new PublicKey(s); return s; }
  catch { throw new HTTPException(400, { message: "invalid pubkey" }); }
}

function siwsMessage(wallet: string, nonce: string): string {
  return `Sign in to Lightly\nWallet: ${wallet}\nNonce: ${nonce}`;
}

// ---------- WebSocket (Bun native) ----------

const PORT = Number(process.env.PORT ?? 4000);

Bun.serve<SocketData, undefined>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      const tableId = url.pathname.slice("/ws/".length);
      const wallet = url.searchParams.get("wallet") ?? "";
      if (!tables.has(tableId)) return new Response("no table", { status: 404 });
      const ok = server.upgrade(req, { data: { tableId, wallet } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const table = tables.get(ws.data.tableId);
      if (!table) { ws.close(); return; }
      table.sockets.add(ws);
      table.engine.setConnected(ws.data.wallet, true);
      ws.send(JSON.stringify({ kind: "snapshot", view: table.engine.view(ws.data.wallet) }));
    },
    message(ws, raw) {
      const table = tables.get(ws.data.tableId);
      if (!table) return;
      let parsed;
      try { parsed = zAction.parse(JSON.parse(raw as string)); }
      catch (e) {
        ws.send(JSON.stringify({ kind: "error", message: `bad action: ${(e as Error).message}` }));
        return;
      }
      try {
        switch (parsed.kind) {
          case "join": {
            // The "join" here is a cosmetic seat assignment; on-chain `buy_in` is the
            // real seat creation and must happen from the client before the dealer
            // considers the seat funded. MVP: if the wallet has a chain seat with balance,
            // the client pre-seats via HTTP; here we just track connection.
            break;
          }
          case "ready": {
            if (table.engine.activeSeats().length >= 2) void table.engine.startHand();
            break;
          }
          case "fold":
          case "check":
          case "call":
            table.engine.act(ws.data.wallet, parsed.kind);
            break;
          case "bet":
            table.engine.act(ws.data.wallet, "bet", parsed.amount);
            break;
          case "raise":
            table.engine.act(ws.data.wallet, "raise", parsed.to);
            break;
          case "sit_out":
            table.engine.leaveSeat(ws.data.wallet);
            break;
          case "ping":
            ws.send(JSON.stringify({ kind: "snapshot", view: table.engine.view(ws.data.wallet) }));
            break;
        }
      } catch (e) {
        ws.send(JSON.stringify({ kind: "error", message: (e as Error).message }));
      }
    },
    close(ws) {
      const table = tables.get(ws.data.tableId);
      if (!table) return;
      table.sockets.delete(ws);
      table.engine.setConnected(ws.data.wallet, false);
    },
  },
});

console.log(`[lightly-api] listening on :${PORT}`);
