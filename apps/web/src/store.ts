import { create } from "zustand";
import type { ServerEvent, TableView } from "@lightly/shared";

type LogEntry = { id: string; text: string; kind?: "action" | "street" | "info" };

type S = {
  view: TableView | null;
  log: LogEntry[];
  connected: boolean;
  lastSeed?: string;
  lastWinners?: Array<{ seat: number; amount: number }>;
  /** Transient showdown reveal kept for a few seconds for the win animation. */
  reveal?: {
    reveals: Array<{ seat: number; hole: [import("@lightly/shared").Card, import("@lightly/shared").Card]; rank: import("@lightly/shared").HandRank }>;
    winners: Array<{ seat: number; amount: number }>;
    seed: string;
  };
  apply: (e: ServerEvent) => void;
  setConnected: (v: boolean) => void;
  clearReveal: () => void;
  reset: () => void;
};

let idCounter = 0;
const nextId = () => `l${++idCounter}`;

export const useGame = create<S>((set) => ({
  view: null,
  log: [],
  connected: false,
  apply: (e) =>
    set((s) => {
      const log = [...s.log];
      const push = (text: string, kind?: LogEntry["kind"]) => {
        log.push({ id: nextId(), text, kind });
        if (log.length > 200) log.shift();
      };
      let view = s.view;
      switch (e.kind) {
        case "snapshot":
          view = e.view;
          break;
        case "hand_start":
          push(`hand #${e.handId} — dealer seat ${e.dealerSeat}`, "info");
          if (view) view = { ...view, handId: e.handId, dealerSeat: e.dealerSeat, commitHash: e.commitHash };
          break;
        case "deal":
          if (view) {
            const seats = view.seats.map((seat) =>
              seat.seatIndex === e.seat ? { ...seat, hole: e.hole ?? null } : seat,
            );
            view = { ...view, seats, commitHash: e.commitHash };
          }
          break;
        case "street":
          push(`── ${e.street.toUpperCase()} ──`, "street");
          if (view) view = { ...view, street: e.street, board: e.board };
          break;
        case "action":
          push(`seat ${e.seat}: ${e.action}${e.amount ? ` ${(e.amount / 1e6).toFixed(2)}` : ""}`, "action");
          break;
        case "to_act":
          if (view) view = { ...view, toActSeat: e.seat, deadline: e.deadline, minRaiseTo: e.minRaiseTo };
          break;
        case "showdown":
          push(`showdown — seed ${e.seed.slice(0, 12)}…`, "info");
          // Reveal cards of every contender on the board; drives the reveal animation.
          if (view) {
            const seats = view.seats.map((seat) => {
              const r = e.reveals.find((rv) => rv.seat === seat.seatIndex);
              return r ? { ...seat, hole: r.hole } : seat;
            });
            view = { ...view, seats };
          }
          return { ...s, view, log, lastSeed: e.seed, reveal: { reveals: e.reveals, winners: [], seed: e.seed } };
        case "settled":
          push(
            `settled: ${e.winners.map((w) => `seat ${w.seat} +${(w.amount / 1e6).toFixed(2)}`).join(", ")}` +
              (e.rake > 0 ? `, rake ${(e.rake / 1e6).toFixed(2)}` : ""),
            "info",
          );
          return {
            ...s,
            view,
            log,
            lastWinners: e.winners,
            reveal: s.reveal ? { ...s.reveal, winners: e.winners } : undefined,
          };
        case "error":
          push(`error: ${e.message}`, "info");
          break;
      }
      return { ...s, view, log };
    }),
  setConnected: (v) => set({ connected: v }),
  clearReveal: () => set((s) => ({ ...s, reveal: undefined })),
  reset: () => set({ view: null, log: [], connected: false, lastSeed: undefined, lastWinners: undefined, reveal: undefined }),
}));
