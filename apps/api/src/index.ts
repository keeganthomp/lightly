/**
 * Lightly API — Hono on Bun.
 *
 * HTTP:
 *   GET  /health
 *   GET  /tables                  list active tables
 *   POST /tables                  operator-only (API key guard for dev)
 *   GET  /tables/:id              current snapshot
 *   POST /auth/nonce              SIWS nonce
 *   POST /auth/verify             SIWS signature verify → sessionId
 *   POST /auth/logout             revoke sessionId
 *
 * WS:
 *   /ws/:tableId?session=<id>     session-bound; server reads the wallet from
 *                                 the session (NOT from a URL param) so nobody
 *                                 can impersonate another player.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ServerWebSocket } from "bun";
import { Connection, PublicKey } from "@solana/web3.js";
import { zAction, type ServerEvent } from "@lightly/shared";
import { decodeSeat, seatPda } from "@lightly/idl";
import { HoldemEngine, type HandOutcome, type TableConfig } from "./engine.ts";
import { issueNonce, resolveSession, revokeSession, verifyAndIssueSession } from "./auth.ts";

const app = new Hono();
app.use("*", cors({ origin: "*", credentials: true }));

// ---------- In-memory state (replace with Postgres for persistence) ----------

type TableEntry = {
  config: TableConfig;
  engine: HoldemEngine;
  sockets: Set<ServerWebSocket<SocketData>>;
  walletToSocket: Map<string, ServerWebSocket<SocketData>>;
  mint: string;
  onchainTableId: bigint;
  tablePda: PublicKey;
};
const tables = new Map<string, TableEntry>();

type SocketData = { tableId: string; wallet: string; sessionId: string };

// ---------- RPC (optional) ----------
//
// If RPC_URL is set, we fetch each joining player's on-chain PlayerSeat PDA and
// require a nonzero balance. In dev without a validator, we skip the check.

const RPC_URL = process.env.RPC_URL ?? "";
const rpc = RPC_URL ? new Connection(RPC_URL, "confirmed") : null;

async function fetchOnchainBalance(tablePda: PublicKey, wallet: string): Promise<bigint | null> {
  if (!rpc) return null; // skip check in dev without validator
  const [seat] = seatPda(tablePda, new PublicKey(wallet));
  const acc = await rpc.getAccountInfo(seat);
  if (!acc) return 0n;
  try { return decodeSeat(acc.data).balance; }
  catch { return 0n; }
}

// ---------- Health ----------

app.get("/health", (c) => c.json({ ok: true, tables: tables.size, rpc: !!rpc }));

// ---------- Tables ----------

app.get("/tables", (c) =>
  c.json(
    [...tables.values()].map((t) => ({
      tableId: t.config.tableId,
      onchainTableId: String(t.onchainTableId),
      tablePda: t.tablePda.toBase58(),
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

// Operator-only table create in dev — API key guard. In prod this is an
// on-chain initialize_table tx from the Squads operator multisig; the API
// just indexes new tables from the chain.
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
  const tablePda = body.tablePda ? new PublicKey(body.tablePda) : new PublicKey("11111111111111111111111111111111");
  createTableEntry(config, body.mint ?? "", BigInt(body.onchainTableId ?? 0), tablePda);
  return c.json({ tableId: config.tableId });
});

function createTableEntry(
  config: TableConfig,
  mint: string,
  onchainTableId: bigint,
  tablePda: PublicKey,
): TableEntry {
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const walletToSocket = new Map<string, ServerWebSocket<SocketData>>();
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
      // In prod: submit begin_hand + settle_hand on-chain here (via Helius Sender,
      // Jito-bundled, operator multisig signer). For the MVP we emit a stub.
      emit({
        kind: "settled",
        winners: outcome.winners,
        rake: outcome.rake,
        txSig: `stub-${outcome.handId}`,
      });
    },
  });
  const entry: TableEntry = { config, engine, sockets, walletToSocket, mint, onchainTableId, tablePda };
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
    new PublicKey("11111111111111111111111111111111"),
  );
}

// ---------- SIWS auth ----------

app.post("/auth/nonce", async (c) => {
  const body = await c.req.json();
  const wallet = z_wallet(body.wallet);
  const { nonce, message } = issueNonce(wallet);
  return c.json({ nonce, message });
});

app.post("/auth/verify", async (c) => {
  const body = await c.req.json();
  const wallet = z_wallet(body.wallet);
  try {
    const sessionId = verifyAndIssueSession(wallet, body.signature);
    return c.json({ sessionId });
  } catch (e) {
    throw new HTTPException(401, { message: (e as Error).message });
  }
});

app.post("/auth/logout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.sessionId) revokeSession(body.sessionId);
  return c.json({ ok: true });
});

function z_wallet(s: unknown): string {
  if (typeof s !== "string") throw new HTTPException(400, { message: "wallet string required" });
  try { new PublicKey(s); return s; }
  catch { throw new HTTPException(400, { message: "invalid pubkey" }); }
}

// ---------- WebSocket (Bun native) ----------

const PORT = Number(process.env.PORT ?? 4000);
const REQUIRE_ONCHAIN_SEAT = process.env.REQUIRE_ONCHAIN_SEAT === "true";
const DEV_ALLOW_UNSIGNED = process.env.DEV_ALLOW_UNSIGNED === "true";

Bun.serve<SocketData, undefined>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      const tableId = url.pathname.slice("/ws/".length);
      const table = tables.get(tableId);
      if (!table) return new Response("no table", { status: 404 });

      const sessionId = url.searchParams.get("session") ?? "";
      let wallet = resolveSession(sessionId);

      // Dev escape hatch — only if explicitly enabled, lets you pass a raw
      // wallet without signing. Never ship this in prod.
      if (!wallet && DEV_ALLOW_UNSIGNED) {
        const raw = url.searchParams.get("wallet");
        if (raw) { try { new PublicKey(raw); wallet = raw; } catch { /* noop */ } }
      }
      if (!wallet) return new Response("unauthenticated", { status: 401 });

      // Optional: require on-chain seat with balance before letting the player join.
      if (REQUIRE_ONCHAIN_SEAT) {
        const bal = await fetchOnchainBalance(table.tablePda, wallet);
        if (bal === null) return new Response("rpc unavailable", { status: 503 });
        if (bal <= 0n) return new Response("no on-chain seat (buy_in first)", { status: 403 });
      }

      // Refuse a second WS for the same wallet — prevents one user from holding
      // multiple sockets on the same seat (e.g. for multi-accounting signal).
      if (table.walletToSocket.has(wallet)) {
        return new Response("already connected", { status: 409 });
      }

      const ok = server.upgrade(req, { data: { tableId, wallet, sessionId } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      const table = tables.get(ws.data.tableId);
      if (!table) { ws.close(); return; }
      table.sockets.add(ws);
      table.walletToSocket.set(ws.data.wallet, ws);
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
        const wallet = ws.data.wallet;
        switch (parsed.kind) {
          case "join":
            // No-op: on-chain `buy_in` is what creates the seat. UI should call
            // `ready` once they've confirmed their on-chain balance.
            break;
          case "ready":
            // Seat the player locally using their on-chain balance as stack.
            // Dev path: we use a hardcoded stack since we don't have RPC wired here.
            if (!table.engine.activeSeats().some((s) => s.wallet === wallet)) {
              const stack = 500_000_000; // 500 USDC in dev; in prod pull from getAccount
              try { table.engine.seatPlayer(wallet, stack); }
              catch (e) {
                ws.send(JSON.stringify({ kind: "error", message: (e as Error).message }));
                break;
              }
            }
            if (table.engine.activeSeats().length >= 2) {
              void table.engine.startHand();
            }
            // Broadcast updated snapshot to everyone on the table.
            for (const otherWs of table.sockets) {
              otherWs.send(
                JSON.stringify({ kind: "snapshot", view: table.engine.view(otherWs.data.wallet) }),
              );
            }
            break;
          case "fold":
          case "check":
          case "call":
            table.engine.act(wallet, parsed.kind);
            break;
          case "bet":
            table.engine.act(wallet, "bet", parsed.amount);
            break;
          case "raise":
            table.engine.act(wallet, "raise", parsed.to);
            break;
          case "sit_out":
            table.engine.requestLeave(wallet); // forfeit-safe
            break;
          case "ping":
            ws.send(JSON.stringify({ kind: "snapshot", view: table.engine.view(wallet) }));
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
      table.walletToSocket.delete(ws.data.wallet);
      table.engine.setConnected(ws.data.wallet, false);
    },
  },
});

console.log(`[lightly-api] listening on :${PORT}${rpc ? ` rpc=${RPC_URL}` : ""}`);
