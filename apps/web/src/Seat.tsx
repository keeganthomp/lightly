import { AnimatePresence, motion } from "framer-motion";
import type { SeatView } from "@lightly/shared";
import { CardBack, PlayingCard } from "./Card.tsx";

export function Seat({
  seat,
  position,
  isMe,
  isToAct,
}: {
  seat: SeatView;
  position: { left: string; top: string };
  isMe: boolean;
  isToAct: boolean;
}) {
  if (!seat.sitting) return null;

  const classes = [
    "seat",
    isMe ? "me" : "",
    seat.folded ? "folded" : "",
    isToAct ? "to-act" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <motion.div
      className={classes}
      style={position}
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
    >
      <div className="chip-row">
        <AnimatePresence>
          {seat.committed > 0 && (
            <motion.span
              key="bet"
              className="pill bet"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {(seat.committed / 1e6).toFixed(2)}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="pill stack">
        <span style={{ color: "var(--text-dim)", marginRight: 8 }}>
          {seat.wallet ? truncate(seat.wallet) : "empty"}
        </span>
        {(seat.stack / 1e6).toFixed(2)}
      </div>
      <div className="hole-row">
        {seat.hole && seat.hole[0] && seat.hole[1] ? (
          <>
            <PlayingCard card={seat.hole[0]} delay={0} />
            <PlayingCard card={seat.hole[1]} delay={0.08} />
          </>
        ) : !seat.folded ? (
          <>
            <CardBack delay={0} />
            <CardBack delay={0.08} />
          </>
        ) : null}
      </div>
    </motion.div>
  );
}

function truncate(s: string, n = 4): string {
  if (s.length <= n * 2) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}
