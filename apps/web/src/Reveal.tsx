import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import { PlayingCard } from "./Card.tsx";
import { useGame } from "./store.ts";

export function RevealOverlay() {
  const reveal = useGame((s) => s.reveal);
  const clear = useGame((s) => s.clearReveal);

  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(clear, 4500);
    return () => clearTimeout(t);
  }, [reveal, clear]);

  return (
    <AnimatePresence>
      {reveal && (
        <motion.div
          key="reveal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(5,10,8,0.55)",
            backdropFilter: "blur(4px)",
            zIndex: 5,
            pointerEvents: "none",
          }}
        >
          <div style={{ display: "flex", gap: 24, flexDirection: "column", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
              {reveal.reveals.map((r, i) => {
                const won = reveal.winners.some((w) => w.seat === r.seat);
                return (
                  <motion.div
                    key={r.seat}
                    layout
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1, scale: won ? 1.05 : 1 }}
                    transition={{ delay: i * 0.12, type: "spring", stiffness: 250, damping: 22 }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 8,
                      padding: 12,
                      borderRadius: 14,
                      border: `1px solid ${won ? "var(--win)" : "var(--border)"}`,
                      background: "rgba(20,20,28,0.85)",
                      boxShadow: won
                        ? "0 0 32px rgba(74,222,128,0.35), 0 0 0 1px rgba(74,222,128,0.25) inset"
                        : "none",
                    }}
                  >
                    <div style={{ display: "flex", gap: 6 }}>
                      <PlayingCard card={r.hole[0]} big delay={i * 0.12} />
                      <PlayingCard card={r.hole[1]} big delay={i * 0.12 + 0.06} />
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-dim)" }}>seat {r.seat}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: won ? "var(--win)" : "var(--text)" }}>
                      {r.rank.category}
                    </div>
                    {won && (
                      <motion.div
                        initial={{ scale: 0.7, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ delay: 0.6 + i * 0.12 }}
                        style={{
                          fontSize: 13,
                          color: "var(--win)",
                          fontWeight: 600,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        +
                        {(
                          (reveal.winners.find((w) => w.seat === r.seat)?.amount ?? 0) / 1e6
                        ).toFixed(2)}{" "}
                        USDC
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
            </div>
            {reveal.seed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.2 }}
                style={{
                  fontSize: 11,
                  fontFamily: "ui-monospace, monospace",
                  color: "var(--text-dim)",
                  padding: "6px 10px",
                  background: "rgba(20,20,28,0.7)",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                }}
              >
                seed: {reveal.seed.slice(0, 16)}… (re-derive deck to verify)
              </motion.div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
