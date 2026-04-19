/**
 * Wallet panel — deposit / withdraw between the user's ATA and their table seat.
 *
 * Renders in the sidebar. Polls balances every 4s and immediately after any
 * successful tx. Signs via wallet-adapter; transactions are sent directly
 * from the browser (no relayer yet — that's Phase 1.2 of the roadmap).
 */
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnimatePresence, motion } from "framer-motion";
import {
  buyIn as chainBuyIn,
  cashOut as chainCashOut,
  fetchConfig,
  fetchSeatBalance,
  fetchWalletTokenBalance,
  type ChainCtx,
  type ServerConfig,
} from "./chain.ts";

type Balances = { wallet: bigint; seat: bigint | null };

export function WalletPanel() {
  const { publicKey, signTransaction } = useWallet();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [balances, setBalances] = useState<Balances>({ wallet: 0n, seat: null });
  const [busy, setBusy] = useState<"buy" | "cash" | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [amountUsd, setAmountUsd] = useState("50");

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => {});
  }, []);

  const ctx: ChainCtx | null = useMemo(() => {
    if (!config?.chainEnabled || !config.defaultTable || !config.rpcUrl) return null;
    return {
      rpc: new Connection(config.rpcUrl, "confirmed"),
      table: new PublicKey(config.defaultTable.tablePda),
      mint: new PublicKey(config.defaultTable.mint),
    };
  }, [config]);

  const refresh = async () => {
    if (!ctx || !publicKey) return;
    const [wallet, seat] = await Promise.all([
      fetchWalletTokenBalance(ctx, publicKey),
      fetchSeatBalance(ctx, publicKey),
    ]);
    setBalances({ wallet, seat });
  };

  useEffect(() => {
    if (!ctx || !publicKey) return;
    refresh();
    const id = setInterval(refresh, 4_000);
    return () => clearInterval(id);

  }, [ctx, publicKey?.toBase58()]);

  if (!config) return null;
  if (!config.chainEnabled) {
    return (
      <section>
        <h3>Wallet</h3>
        <div className="wallet-note">
          Chain disabled — running in off-chain dev mode. Set <code>RPC_URL</code> and run{" "}
          <code>bun run scripts/bootstrap.ts</code> to enable real USDC.
        </div>
      </section>
    );
  }
  if (!publicKey || !ctx || !signTransaction) return null;

  const microPer = 1_000_000n;
  const amountMicro = BigInt(Math.round(Number(amountUsd) * 1e6));

  async function doBuyIn() {
    if (!ctx || !publicKey || !signTransaction) return;
    setBusy("buy"); setStatus(null);
    try {
      const sig = await chainBuyIn(ctx, publicKey, amountMicro, signTransaction);
      setStatus({ kind: "ok", msg: `deposit confirmed` });
      console.log("[buy_in]", sig);
      await refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function doCashOut() {
    if (!ctx || !publicKey || !signTransaction) return;
    setBusy("cash"); setStatus(null);
    try {
      const sig = await chainCashOut(ctx, publicKey, amountMicro, signTransaction);
      setStatus({ kind: "ok", msg: `withdraw confirmed` });
      console.log("[cash_out]", sig);
      await refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const walletUsd = Number(balances.wallet / microPer) + Number(balances.wallet % microPer) / 1e6;
  const seatUsd =
    balances.seat === null
      ? null
      : Number(balances.seat / microPer) + Number(balances.seat % microPer) / 1e6;

  return (
    <section>
      <h3>Wallet</h3>
      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">in wallet</span>
          <span className="stat-value">${walletUsd.toFixed(2)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">at table</span>
          <span className="stat-value">{seatUsd === null ? "—" : `$${seatUsd.toFixed(2)}`}</span>
        </div>
      </div>
      <div className="amount-row">
        <label>
          amount
          <input
            className="size"
            type="number"
            min="0"
            step="10"
            value={amountUsd}
            onChange={(e) => setAmountUsd(e.target.value)}
          />
        </label>
      </div>
      <div className="button-row">
        <button className="primary" onClick={doBuyIn} disabled={busy !== null || amountMicro <= 0n}>
          {busy === "buy" ? "Depositing…" : "Deposit"}
        </button>
        <button onClick={doCashOut} disabled={busy !== null || seatUsd === null || amountMicro <= 0n}>
          {busy === "cash" ? "Withdrawing…" : "Withdraw"}
        </button>
      </div>
      <AnimatePresence>
        {status && (
          <motion.div
            key={status.msg}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`wallet-status ${status.kind}`}
          >
            {status.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
