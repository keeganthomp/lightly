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
                      gap: "var(--space-2)",
                      padding: "var(--space-4)",
                      borderRadius: "var(--radius-lg)",
                      border: `1px solid ${won ? "var(--win)" : "var(--border)"}`,
                      background: "var(--bg-elev)",
                      boxShadow: won
                        ? "0 0 0 1px oklch(0.74 0.12 145 / 0.35) inset, 0 12px 30px -10px oklch(0.74 0.12 145 / 0.3)"
                        : "var(--shadow-card)",
                    }}
                  >
                    <div style={{ display: "flex", gap: 6 }}>
                      <PlayingCard card={r.hole[0]} big delay={i * 0.12} />
                      <PlayingCard card={r.hole[1]} big delay={i * 0.12 + 0.06} />
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.2em" }}>
                      seat {r.seat}
                    </div>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: won ? "var(--win)" : "var(--text)", fontFamily: "var(--font-display)" }}>
                      {r.rank.category}
                    </div>
                    {won && (
                      <motion.div
                        initial={{ y: 4, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ delay: 0.6 + i * 0.12, duration: 0.28, ease: [0.2, 0.9, 0.2, 1] }}
                        style={{
                          fontSize: "var(--text-sm)",
                          color: "var(--win)",
                          fontWeight: 600,
                          fontFamily: "var(--font-mono)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        +${((reveal.winners.find((w) => w.seat === r.seat)?.amount ?? 0) / 1e6).toFixed(2)}
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
                  fontSize: "var(--text-xs)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-faint)",
                  padding: "var(--space-2) var(--space-3)",
                  background: "var(--bg-elev)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-soft)",
                  letterSpacing: "0.02em",
                }}
              >
                seed {reveal.seed.slice(0, 16)}… · re-derive deck to verify
              </motion.div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
