import { useEffect, useMemo, useRef } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Action, ServerEvent } from "@lightly/shared";
import { Table } from "./Table.tsx";
import { useGame } from "./store.ts";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";
const API_URL = import.meta.env.VITE_API_URL ?? "/api";
const DEFAULT_TABLE = "demo";

export function App() {
  const { publicKey, connected } = useWallet();
  const wallet = publicKey?.toBase58() ?? "";
  const sendRef = useRef<(a: Action) => void>(() => {});

  useEffect(() => {
    if (!connected || !wallet) return;
    const ws = new WebSocket(`${WS_URL}/ws/${DEFAULT_TABLE}?wallet=${encodeURIComponent(wallet)}`);
    ws.onopen = () => {
      useGame.getState().setConnected(true);
      ws.send(JSON.stringify({ kind: "join", table: DEFAULT_TABLE, wallet }));
    };
    ws.onclose = () => useGame.getState().setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as ServerEvent;
        useGame.getState().apply(parsed);
      } catch {
        /* noop */
      }
    };
    sendRef.current = (a) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a));
    };
    return () => { ws.close(); useGame.getState().reset(); };
  }, [wallet, connected]);

  const send = useMemo(() => (a: Action) => sendRef.current(a), []);
  const log = useGame((s) => s.log);
  const isConnected = useGame((s) => s.connected);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span>◈</span> Lightly
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>
            {isConnected ? "● live" : "○ offline"}
          </div>
          <WalletMultiButton />
        </div>
      </header>

      <div className="main">
        {connected && wallet ? (
          <Table tableId={DEFAULT_TABLE} wallet={wallet} send={send} />
        ) : (
          <div className="empty-state">
            <h2 style={{ marginBottom: 8 }}>Connect a wallet to join the felt.</h2>
            <p>Texas Hold'em. USDC. VRF-audited shuffles.</p>
          </div>
        )}

        <aside className="sidebar">
          <section>
            <h3>Controls</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => send({ kind: "ready" })} className="primary" disabled={!isConnected}>
                Start hand
              </button>
              <button onClick={() => send({ kind: "sit_out" })} disabled={!isConnected}>
                Sit out
              </button>
              <button onClick={() => send({ kind: "ping" })} disabled={!isConnected}>
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
                log
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div key={e.id}>
                      <span className={e.kind ? `c-${e.kind}` : ""}>{e.text}</span>
                    </div>
                  ))
              )}
            </div>
          </section>
          <section>
            <h3>About fairness</h3>
            <p style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>
              Every hand is dealt from a deck shuffled by a 32-byte VRF seed. The sha256
              commit of that seed is shown on the table pre-deal; the seed itself is
              revealed on showdown so you can re-derive the deck and verify the dealer.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
