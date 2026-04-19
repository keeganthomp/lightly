import { create } from "zustand";
import type { ServerEvent, TableView } from "@lightly/shared";

type LogEntry = { id: string; text: string; kind?: "action" | "street" | "info" };

type S = {
  view: TableView | null;
  log: LogEntry[];
  connected: boolean;
  lastSeed?: string;
  lastWinners?: Array<{ seat: number; amount: number }>;
  apply: (e: ServerEvent) => void;
  setConnected: (v: boolean) => void;
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
          return { ...s, view, log, lastSeed: e.seed };
        case "settled":
          push(
            `settled: ${e.winners.map((w) => `seat ${w.seat} +${(w.amount / 1e6).toFixed(2)}`).join(", ")}` +
              (e.rake > 0 ? `, rake ${(e.rake / 1e6).toFixed(2)}` : ""),
            "info",
          );
          return { ...s, view, log, lastWinners: e.winners };
        case "error":
          push(`error: ${e.message}`, "info");
          break;
      }
      return { ...s, view, log };
    }),
  setConnected: (v) => set({ connected: v }),
  reset: () => set({ view: null, log: [], connected: false, lastSeed: undefined, lastWinners: undefined }),
}));
