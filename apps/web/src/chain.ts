/**
 * Client-side chain helpers. Signs via wallet-adapter + submits to an RPC.
 *
 * The RPC URL, table PDA, and mint are pulled from GET /config so nothing is
 * hardcoded in the frontend.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ataFor,
  ixBuyIn,
  ixCashOut,
  seatPda,
  decodeSeat,
} from "@lightly/idl";

export type ChainCtx = {
  rpc: Connection;
  table: PublicKey;
  mint: PublicKey;
};

const API = import.meta.env.VITE_API_URL ?? "/api";

export type ServerConfig = {
  rpcUrl: string | null;
  chainEnabled: boolean;
  programId: string;
  defaultTable: {
    tableId: string;
    onchainTableId: string;
    tablePda: string;
    mint: string;
    minBuyIn: string;
    maxBuyIn: string;
    bigBlind: string;
  } | null;
};

export async function fetchConfig(): Promise<ServerConfig> {
  const res = await fetch(`${API}/config`);
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  return (await res.json()) as ServerConfig;
}

/**
 * Query on-chain seat balance. Returns bigint in micro-USDC, or null if the
 * seat doesn't exist yet.
 */
export async function fetchSeatBalance(ctx: ChainCtx, wallet: PublicKey): Promise<bigint | null> {
  const [seat] = seatPda(ctx.table, wallet);
  const acc = await ctx.rpc.getAccountInfo(seat);
  if (!acc) return null;
  try { return decodeSeat(acc.data).balance; }
  catch { return null; }
}

/** User's SPL token (dev-USDC) balance — for showing "you have X to deposit". */
export async function fetchWalletTokenBalance(
  ctx: ChainCtx,
  wallet: PublicKey,
): Promise<bigint> {
  const ata = ataFor(wallet, ctx.mint);
  const acc = await ctx.rpc.getAccountInfo(ata);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

async function sendIxs(
  ctx: ChainCtx,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  signTx: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = payer;
  const { blockhash, lastValidBlockHeight } = await ctx.rpc.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await signTx(tx);
  const sig = await ctx.rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  await ctx.rpc.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

/** Ensure the player's own ATA for the table mint exists; create if missing. */
function ensureAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0) as unknown as Buffer,
  } as unknown as TransactionInstruction;
}

export async function buyIn(
  ctx: ChainCtx,
  player: PublicKey,
  amount: bigint,
  signTx: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const ata = ataFor(player, ctx.mint);
  const ataInfo = await ctx.rpc.getAccountInfo(ata);
  const ixs: TransactionInstruction[] = [];
  if (!ataInfo) ixs.push(ensureAtaIx(player, player, ctx.mint));
  ixs.push(
    ixBuyIn({ player, table: ctx.table, tokenMint: ctx.mint, amount }),
  );
  return sendIxs(ctx, player, ixs, signTx);
}

export async function cashOut(
  ctx: ChainCtx,
  player: PublicKey,
  amount: bigint,
  signTx: (tx: Transaction) => Promise<Transaction>,
): Promise<string> {
  const ix = ixCashOut({ player, table: ctx.table, tokenMint: ctx.mint, amount });
  return sendIxs(ctx, player, [ix], signTx);
}
