import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Action, TableView } from "@lightly/shared";
import { PlayingCard } from "./Card.tsx";
import { RevealOverlay } from "./Reveal.tsx";
import { Seat } from "./Seat.tsx";
import { useGame } from "./store.ts";

const SEAT_POSITIONS: Array<{ left: string; top: string }> = [
  { left: "50%", top: "96%" },   // 0 — bottom center (you)
  { left: "10%", top: "76%" },   // 1
  { left: "0%",  top: "32%" },   // 2
  { left: "25%", top: "-4%" },   // 3
  { left: "75%", top: "-4%" },   // 4
  { left: "100%", top: "32%" },  // 5
  { left: "90%", top: "76%" },   // 6
  { left: "66%", top: "96%" },   // 7
  { left: "34%", top: "96%" },   // 8
];

export function Table({ tableId, wallet, send }: { tableId: string; wallet: string; send: (a: Action) => void }) {
  const view = useGame((s) => s.view);
  if (!view) return <div className="empty-state">connecting to <b>{tableId}</b>…</div>;

  const rotated = useMemo(() => rotateToMe(view), [view]);
  const me = rotated.seats[0];

  return (
    <div className="felt">
      <div className="commit" title="sha256(VRF seed) — revealed post-hand">
        commit: {view.commitHash ? view.commitHash.slice(0, 12) : "—"}
      </div>
      <div className="table-ellipse" style={{ position: "relative" }}>
        <div className="table-label">Lightly • {tableId}</div>
        <Pot amount={view.pot} />
        <Board cards={view.board} />
        {rotated.seats.map((s, i) => (
          <Seat
            key={s.seatIndex + "-" + (s.wallet || "empty")}
            seat={s}
            position={SEAT_POSITIONS[i] ?? SEAT_POSITIONS[0]!}
            isMe={s.wallet === wallet}
            isToAct={rotated.toActSeat === s.seatIndex}
          />
        ))}
        {me && me.wallet === wallet && rotated.toActSeat === me.seatIndex && (
          <ActionBar view={view} toCall={Math.max(0, view.currentBet - me.committed)} send={send} />
        )}
        <RevealOverlay />
      </div>
    </div>
  );
}

function Pot({ amount }: { amount: number }) {
  return (
    <motion.div
      className="pot"
      key={amount}
      initial={{ scale: 0.9, opacity: 0.6 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      pot {(amount / 1e6).toFixed(2)}
    </motion.div>
  );
}

function Board({ cards }: { cards: TableView["board"] }) {
  return (
    <div className="board">
      <AnimatePresence>
        {cards.map((c, i) => (
          <PlayingCard key={c + i} card={c} big delay={i * 0.08} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ActionBar({
  view,
  toCall,
  send,
}: {
  view: TableView;
  toCall: number;
  send: (a: Action) => void;
}) {
  const minRaiseUsdc = (view.minRaiseTo / 1e6).toFixed(2);
  const [sizeUsdc, setSize] = useState(minRaiseUsdc);
  const sizeMicro = Math.round(Number(sizeUsdc) * 1e6);
  const [pct, setPct] = useState(1);

  const deadline = view.deadline ?? 0;
  const startedAt = useRef<number>(Date.now());
  const lastDeadline = useRef(deadline);
  useEffect(() => {
    if (deadline !== lastDeadline.current) {
      lastDeadline.current = deadline;
      startedAt.current = Date.now();
      setSize(minRaiseUsdc);
      setPct(1);
    }
    const id = setInterval(() => {
      const total = Math.max(1, deadline - startedAt.current);
      const remaining = Math.max(0, deadline - Date.now());
      setPct(Math.max(0, Math.min(1, remaining / total)));
    }, 100);
    return () => clearInterval(id);
  }, [deadline, minRaiseUsdc]);

  // Keyboard shortcuts — F/C/R for fold/check-call/raise (feels snappier than clicking).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "f" || e.key === "F") send({ kind: "fold" });
      else if (e.key === "c" || e.key === "C") send(toCall === 0 ? { kind: "check" } : { kind: "call" });
      else if (e.key === "r" || e.key === "R")
        send(view.currentBet === 0 ? { kind: "bet", amount: sizeMicro } : { kind: "raise", to: sizeMicro });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send, sizeMicro, toCall, view.currentBet]);

  const tint = pct < 0.3 ? "var(--danger)" : pct < 0.6 ? "#ffb547" : "var(--accent-2)";

  return (
    <motion.div
      className="actions"
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
    >
      <div
        className="deadline-bar"
        style={{ width: "100%", transform: `scaleX(${pct})`, background: tint }}
      />
      <button onClick={() => send({ kind: "fold" })} title="F">Fold</button>
      {toCall === 0 ? (
        <button onClick={() => send({ kind: "check" })} title="C">Check</button>
      ) : (
        <button onClick={() => send({ kind: "call" })} title="C">
          Call {(toCall / 1e6).toFixed(2)}
        </button>
      )}
      <input
        className="size"
        type="number"
        min={Number(minRaiseUsdc)}
        step="0.01"
        value={sizeUsdc}
        onChange={(e) => setSize(e.target.value)}
      />
      {view.currentBet === 0 ? (
        <button className="primary" onClick={() => send({ kind: "bet", amount: sizeMicro })} title="R">
          Bet {sizeUsdc}
        </button>
      ) : (
        <button className="primary" onClick={() => send({ kind: "raise", to: sizeMicro })} title="R">
          Raise to {sizeUsdc}
        </button>
      )}
    </motion.div>
  );
}

/** Rotate so the viewer's seat is seat index 0 (bottom-center). */
function rotateToMe(view: TableView): TableView {
  if (view.you < 0) return view;
  const n = view.seats.length;
  const seats = Array.from({ length: n }, (_, i) => view.seats[(view.you + i) % n]!);
  return { ...view, seats };
}
