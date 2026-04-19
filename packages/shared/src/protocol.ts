/**
 * Wire protocol for the table WebSocket.
 * Server → client events and client → server actions.
 */
import { z } from "zod";
import type { Card, HandRank } from "./cards.ts";

// ---------- Client → server ----------

export const zAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("join"), table: z.string(), wallet: z.string() }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("fold") }),
  z.object({ kind: z.literal("check") }),
  z.object({ kind: z.literal("call") }),
  z.object({ kind: z.literal("bet"), amount: z.number().int().positive() }),
  z.object({ kind: z.literal("raise"), to: z.number().int().positive() }),
  z.object({ kind: z.literal("sit_out") }),
  z.object({ kind: z.literal("ping") }),
]);
export type Action = z.infer<typeof zAction>;

// ---------- Server → client events ----------

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "idle";

export type SeatView = {
  seatIndex: number;
  wallet: string;
  stack: number;        // chips in micro-USDC (1e6 = 1 USDC)
  committed: number;    // chips put in pot this street
  hole?: [Card, Card] | null;  // only set for `you`
  folded: boolean;
  allIn: boolean;
  actedThisStreet: boolean;
  sitting: boolean;
  connected: boolean;
};

export type TableView = {
  tableId: string;
  handId: number;
  street: Street;
  dealerSeat: number;
  toActSeat: number | null;
  board: Card[];
  pot: number;
  minRaiseTo: number;
  currentBet: number;
  seats: SeatView[];
  deadline?: number;    // ms epoch when turn expires
  you: number;          // seat index of the viewer
  commitHash: string;   // sha256 of VRF seed — revealed at showdown
};

export type ServerEvent =
  | { kind: "snapshot"; view: TableView }
  | { kind: "hand_start"; handId: number; dealerSeat: number; commitHash: string }
  | { kind: "deal"; seat: number; hole?: [Card, Card] | null; commitHash: string }
  | { kind: "street"; street: Street; board: Card[] }
  | { kind: "action"; seat: number; action: "fold" | "check" | "call" | "bet" | "raise" | "all_in"; amount?: number }
  | { kind: "to_act"; seat: number; deadline: number; minRaiseTo: number; callAmount: number }
  | { kind: "showdown"; reveals: Array<{ seat: number; hole: [Card, Card]; rank: HandRank }>; seed: string; vrfProof: string }
  | { kind: "settled"; winners: Array<{ seat: number; amount: number }>; rake: number; txSig: string }
  | { kind: "error"; message: string };
