/**
 * Shared LiteSVM test harness.
 *
 * In-process SVM + our compiled `poker.so` + a fresh SPL mint + funded players.
 * Deterministic, sub-ms per ix, no network.
 */
import { LiteSVM, FailedTransactionMetadata, TransactionMetadata } from "litesvm";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  POKER_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ataFor,
  decodeReceipt,
  decodeSeat,
  decodeTable,
  type ReceiptAccount,
  type SeatAccount,
  type TableAccount,
} from "@lightly/idl";
import { join } from "node:path";

export const PROGRAM_SO_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "target",
  "deploy",
  "poker.so",
);

export type SendResult = TransactionMetadata | FailedTransactionMetadata;

export type Harness = {
  svm: LiteSVM;
  payer: Keypair;
  mint: PublicKey;
  mintAuthority: Keypair;
  operator: Keypair;
  players: Keypair[];
  treasury: Keypair;
  treasuryAta: PublicKey;
  send: (ixs: TransactionInstruction[], signers: Keypair[]) => SendResult;
  fetchTable: (table: PublicKey) => TableAccount;
  fetchSeat: (seat: PublicKey) => SeatAccount;
  fetchReceipt: (receipt: PublicKey) => ReceiptAccount;
  tokenBalance: (ata: PublicKey) => bigint;
  warpSlots: (n: bigint) => void;
};

export function bootstrap(opts: { numPlayers?: number; mintTokens?: bigint } = {}): Harness {
  const numPlayers = opts.numPlayers ?? 3;
  const mintTokens = opts.mintTokens ?? 1_000_000_000n;

  const svm = new LiteSVM();
  svm.addProgramFromFile(POKER_PROGRAM_ID, PROGRAM_SO_PATH);

  const payer = Keypair.generate();
  svm.airdrop(payer.publicKey, 100n * 1_000_000_000n);

  const operator = Keypair.generate();
  svm.airdrop(operator.publicKey, 10n * 1_000_000_000n);

  const players: Keypair[] = Array.from({ length: numPlayers }, () => Keypair.generate());
  for (const p of players) svm.airdrop(p.publicKey, 1n * 1_000_000_000n);

  const treasury = Keypair.generate();
  svm.airdrop(treasury.publicKey, 1n * 1_000_000_000n);

  const mintAuthority = Keypair.generate();
  const mint = createMint(svm, payer, mintAuthority.publicKey, 6);

  for (const owner of [operator, ...players]) {
    createAta(svm, payer, owner.publicKey, mint);
    mintTo(svm, payer, mintAuthority, mint, ataFor(owner.publicKey, mint), mintTokens);
  }

  const treasuryAta = ataFor(treasury.publicKey, mint);
  createAta(svm, payer, treasury.publicKey, mint);

  function send(ixs: TransactionInstruction[], signers: Keypair[]): SendResult {
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    for (const ix of ixs) tx.add(ix);
    tx.sign(...signers);
    const res = svm.sendTransaction(tx);
    // Expire blockhash so next identical tx isn't rejected as AlreadyProcessed.
    svm.expireBlockhash();
    return res;
  }

  function fetchTable(table: PublicKey): TableAccount {
    const acc = svm.getAccount(table);
    if (!acc) throw new Error(`table missing: ${table.toBase58()}`);
    return decodeTable(acc.data);
  }
  function fetchSeat(seat: PublicKey): SeatAccount {
    const acc = svm.getAccount(seat);
    if (!acc) throw new Error(`seat missing: ${seat.toBase58()}`);
    return decodeSeat(acc.data);
  }
  function fetchReceipt(receipt: PublicKey): ReceiptAccount {
    const acc = svm.getAccount(receipt);
    if (!acc) throw new Error(`receipt missing: ${receipt.toBase58()}`);
    return decodeReceipt(acc.data);
  }
  function tokenBalance(ata: PublicKey): bigint {
    const acc = svm.getAccount(ata);
    if (!acc) return 0n;
    return Buffer.from(acc.data).readBigUInt64LE(64);
  }
  function warpSlots(n: bigint): void {
    const clock = svm.getClock();
    const next = clock.slot + n;
    svm.warpToSlot(next);
  }

  return {
    svm,
    payer,
    mint,
    mintAuthority,
    operator,
    players,
    treasury,
    treasuryAta,
    send,
    fetchTable,
    fetchSeat,
    fetchReceipt,
    tokenBalance,
    warpSlots,
  };
}

export function isFailed(res: SendResult): res is FailedTransactionMetadata {
  return res instanceof FailedTransactionMetadata;
}

export function assertSuccess(res: SendResult, ctx = ""): TransactionMetadata {
  if (isFailed(res)) {
    throw new Error(`${ctx} expected success, got: ${res.toString()}`);
  }
  return res;
}

export function assertFailure(res: SendResult, needleHex?: string): FailedTransactionMetadata {
  if (!isFailed(res)) {
    throw new Error(`expected failure, got success`);
  }
  if (needleHex) {
    const str = res.toString();
    if (!str.includes(needleHex)) {
      throw new Error(`expected error containing "${needleHex}", got: ${str}`);
    }
  }
  return res;
}

// Convert Anchor ErrorCode ordinal to the hex code printed by Solana logs.
// Anchor starts user errors at 6000.
export function anchorErr(ordinal: number): string {
  return `0x${(6000 + ordinal).toString(16)}`;
}

// ---------- Bare-metal SPL Token helpers ----------

const MINT_SIZE = 82;

function createMint(svm: LiteSVM, payer: Keypair, authority: PublicKey, decimals: number): PublicKey {
  const mint = Keypair.generate();
  const lamports = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: MINT_SIZE,
    lamports: Number(lamports),
    programId: TOKEN_PROGRAM_ID,
  });
  // initializeMint2: disc 20, decimals u8, authority Pubkey, freeze Option<Pubkey> (0 = none)
  const data = Buffer.concat([
    Buffer.from([20]),
    Buffer.from([decimals]),
    authority.toBuffer(),
    Buffer.from([0]),
  ]);
  const initIx = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
    data,
  });
  const tx = new Transaction().add(createIx, initIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, mint);
  const res = svm.sendTransaction(tx);
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`createMint: ${res.toString()}`);
  }
  return mint.publicKey;
}

function createAta(svm: LiteSVM, payer: Keypair, owner: PublicKey, mint: PublicKey): PublicKey {
  const ata = ataFor(owner, mint);
  const ix = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([]),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const res = svm.sendTransaction(tx);
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`createAta: ${res.toString()}`);
  }
  return ata;
}

function mintTo(
  svm: LiteSVM,
  payer: Keypair,
  authority: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  amount: bigint,
): void {
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(amount);
  const data = Buffer.concat([Buffer.from([7]), amtBuf]);
  const ix = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, authority);
  const res = svm.sendTransaction(tx);
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`mintTo: ${res.toString()}`);
  }
}
