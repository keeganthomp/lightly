import { useEffect, useMemo, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { AnimatePresence, motion } from "framer-motion";
import type { Action, ServerEvent } from "@lightly/shared";
import { Table } from "./Table.tsx";
import { useGame } from "./store.ts";
import { clearSession, getSession, signIn } from "./auth.ts";
import { WalletPanel } from "./Wallet.tsx";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";
const DEFAULT_TABLE = "demo";

type AuthState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "ready"; sessionId: string }
  | { kind: "error"; message: string };

export function App() {
  const { publicKey, connected, signMessage, disconnect } = useWallet();
  const wallet = publicKey?.toBase58() ?? "";
  const sendRef = useRef<(a: Action) => void>(() => {});
  const [auth, setAuth] = useState<AuthState>({ kind: "idle" });

  // Sign in when the wallet connects; reuse session if present.
  useEffect(() => {
    if (!connected || !wallet) {
      clearSession();
      setAuth({ kind: "idle" });
      return;
    }
    const existing = getSession(wallet);
    if (existing) { setAuth({ kind: "ready", sessionId: existing }); return; }
    if (!signMessage) { setAuth({ kind: "error", message: "wallet can't sign messages" }); return; }
    setAuth({ kind: "signing" });
    signIn(wallet, async (msg) => signMessage(msg))
      .then((sessionId) => setAuth({ kind: "ready", sessionId }))
      .catch((e: Error) => setAuth({ kind: "error", message: e.message }));
  }, [connected, wallet, signMessage]);

  // Open WS once authed.
  useEffect(() => {
    if (auth.kind !== "ready") return;
    const url = `${WS_URL}/ws/${DEFAULT_TABLE}?session=${encodeURIComponent(auth.sessionId)}`;
    const ws = new WebSocket(url);
    ws.onopen = () => useGame.getState().setConnected(true);
    ws.onclose = () => useGame.getState().setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as ServerEvent;
        useGame.getState().apply(parsed);
      } catch { /* noop */ }
    };
    sendRef.current = (a) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a));
    };
    return () => { ws.close(); useGame.getState().reset(); };
  }, [auth]);

  const send = useMemo(() => (a: Action) => sendRef.current(a), []);
  const log = useGame((s) => s.log);
  const isConnected = useGame((s) => s.connected);

  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden /> Lightly</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <AuthBadge auth={auth} connected={isConnected} onLogout={() => { clearSession(); disconnect(); }} />
          <WalletMultiButton />
        </div>
      </header>

      <div className="main">
        <MainArea auth={auth} wallet={wallet} send={send} />
        <aside className="sidebar">
          <WalletPanel />
          <section>
            <h3>Controls</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => send({ kind: "ready" })} className="primary" disabled={auth.kind !== "ready"}>
                Start hand
              </button>
              <button onClick={() => send({ kind: "sit_out" })} disabled={auth.kind !== "ready"}>
                Sit out
              </button>
              <button onClick={() => send({ kind: "ping" })} disabled={auth.kind !== "ready"}>
                Refresh
              </button>
            </div>
          </section>
          <section>
            <h3>Hand log</h3>
            <div className="log">
              {log.length === 0 ? (
                <div style={{ opacity: 0.6 }}>no events yet</div>
              ) : (
                log.slice().reverse().map((e) => (
                  <div key={e.id}><span className={e.kind ? `c-${e.kind}` : ""}>{e.text}</span></div>
                ))
              )}
            </div>
          </section>
          <section>
            <h3>Fairness</h3>
            <p style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>
              Each hand is shuffled from a 32-byte VRF seed. <b>sha256(seed)</b> is posted
              pre-deal; the seed is revealed on showdown. Re-derive the deck from the seed
              with <code>shuffleDeck()</code> in <code>@lightly/shared</code>.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function MainArea({ auth, wallet, send }: { auth: AuthState; wallet: string; send: (a: Action) => void }) {
  if (auth.kind === "idle") {
    return (
      <div className="empty-state">
        <h2 style={{ marginBottom: 8 }}>Connect a wallet to join the felt.</h2>
        <p>Texas Hold'em. USDC. VRF-audited shuffles.</p>
      </div>
    );
  }
  if (auth.kind === "signing") {
    return <div className="empty-state">✎ Sign the Lightly message in your wallet…</div>;
  }
  if (auth.kind === "error") {
    return <div className="empty-state" style={{ color: "var(--danger)" }}>Sign-in failed: {auth.message}</div>;
  }
  return <Table tableId="demo" wallet={wallet} send={send} />;
}

function AuthBadge({
  auth,
  connected,
  onLogout,
}: {
  auth: AuthState;
  connected: boolean;
  onLogout: () => void;
}) {
  return (
    <AnimatePresence>
      <motion.div
        key={`${auth.kind}-${connected}`}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          fontSize: 12,
          color: "var(--text-dim)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        {auth.kind === "ready" ? (
          <>
            <span style={{ color: connected ? "var(--win)" : "var(--text-dim)" }}>
              {connected ? "● live" : "○ offline"}
            </span>
            <span>· signed in</span>
            <button onClick={onLogout} style={{ padding: "2px 8px", fontSize: 11 }}>
              logout
            </button>
          </>
        ) : auth.kind === "signing" ? (
          <span>signing…</span>
        ) : auth.kind === "error" ? (
          <span style={{ color: "var(--danger)" }}>auth error</span>
        ) : (
          <span>not signed in</span>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
