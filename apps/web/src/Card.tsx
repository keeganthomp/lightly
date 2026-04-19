import { motion } from "framer-motion";
import type { Card as CardT } from "@lightly/shared";

const SUIT_GLYPH: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const SUIT_COLOR = (s: string) => (s === "h" || s === "d" ? "red" : "black");
const EASE = [0.2, 0.9, 0.2, 1] as const;

export function PlayingCard({
  card,
  big = false,
  delay = 0,
}: { card: CardT; big?: boolean; delay?: number }) {
  const rank = card[0];
  const suit = card[1]!;
  return (
    <motion.div
      className={`card ${big ? "board" : ""} ${SUIT_COLOR(suit)}`}
      initial={{ opacity: 0, y: -6, rotateY: 85 }}
      animate={{ opacity: 1, y: 0, rotateY: 0 }}
      transition={{ duration: 0.38, delay, ease: EASE }}
    >
      <span className="rank">{rank === "T" ? "10" : rank}</span>
      <span className="suit">{SUIT_GLYPH[suit]}</span>
    </motion.div>
  );
}

export function CardBack({ delay = 0 }: { delay?: number }) {
  return (
    <motion.div
      className="card back"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay, ease: EASE }}
    />
  );
}
