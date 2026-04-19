/**
 * On-chain settlement submitter.
 *
 * Loads the operator keypair + RPC connection at startup, then exposes
 * fire-and-forget submitBeginHand / submitSettleHand used by the engine.
 *
 * The engine proceeds optimistically off-chain. When a hand ends, we
 * submit settle_hand with real deltas and emit `settled` with the actual
 * tx sig once confirmed. If the tx fails we emit an `error` event — the
 * players' emergency_timeout_refund backstop still protects their funds.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type ConfirmOptions,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { ixBeginHand, ixSettleHand, type SeatDelta, seatPda, tablePda } from "@lightly/idl";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export type ChainConfig = {
  rpcUrl: string;
  commitment: "processed" | "confirmed" | "finalized";
  operator: Keypair;
  tableId: bigint;
  tablePda: PublicKey;
};

export function loadChainConfig(): ChainConfig | null {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) return null; // chain disabled — API runs off-chain only
  const operatorPath = process.env.OPERATOR_KEYPAIR_PATH ?? `${homedir()}/.config/solana/id.json`;
  const tableId = BigInt(process.env.TABLE_ID ?? "1");
  const [pda] = tablePda(tableId);
  const operator = loadKeypair(operatorPath);
  return {
    rpcUrl,
    commitment: (process.env.COMMITMENT as ChainConfig["commitment"]) ?? "confirmed",
    operator,
    tableId,
    tablePda: pda,
  };
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf-8").trim();
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}

export class Chain {
  readonly connection: Connection;
  constructor(readonly config: ChainConfig) {
    this.connection = new Connection(config.rpcUrl, { commitment: config.commitment });
  }

  async health(): Promise<{ slot: number; version: string }> {
    const [slot, version] = await Promise.all([
      this.connection.getSlot(),
      this.connection.getVersion(),
    ]);
    return { slot, version: version["solana-core"] };
  }

  async submitBeginHand(handId: bigint, playerWallets: string[]): Promise<string> {
    const seats = playerWallets.map((w) => seatPda(this.config.tablePda, new PublicKey(w))[0]);
    const ix = ixBeginHand({
      operator: this.config.operator.publicKey,
      table: this.config.tablePda,
      handId,
      seats,
    });
    return this.sendOne([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ix]);
  }

  async submitSettleHand(
    handId: bigint,
    deltas: Array<{ wallet: string; debit: bigint; credit: bigint }>,
    rake: bigint,
  ): Promise<string> {
    const seatDeltas: SeatDelta[] = deltas.map((d) => ({
      player: new PublicKey(d.wallet),
      debit: d.debit,
      credit: d.credit,
    }));
    const ix = ixSettleHand({
      operator: this.config.operator.publicKey,
      table: this.config.tablePda,
      handId,
      deltas: seatDeltas,
      rake,
    });
    return this.sendOne([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix,
    ]);
  }

  private async sendOne(
    instructions: Array<Parameters<Transaction["add"]>[0]>,
  ): Promise<string> {
    const tx = new Transaction();
    for (const ix of instructions) tx.add(ix);
    tx.feePayer = this.config.operator.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(this.config.operator);
    const opts: ConfirmOptions = { commitment: this.config.commitment, skipPreflight: false };
    const sig = await this.connection.sendRawTransaction(tx.serialize(), opts);
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      this.config.commitment,
    );
    return sig;
  }
}
