/**
 * Hand-crafted Anchor IDL helpers for the `poker` program.
 *
 * We hand-encode rather than use anchor-generated TS so:
 *   - tests + the API + the UI all share one set of typed builders
 *   - we avoid depending on the anchor CLI in CI
 *   - the discriminator math is explicit and auditable
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import * as borsh from "borsh";

export const POKER_PROGRAM_ID = new PublicKey(
  "9FeibPV2hjbkcu4YHSnUMr9ikWV7QLWMmBpVFZAcYsZH",
);

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

// ---------- Discriminators ----------
// Anchor prepends sha256("global:<snake_name>")[..8] to every ix data.
function disc(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

export const IX = {
  initializeTable: disc("initialize_table"),
  buyIn: disc("buy_in"),
  cashOut: disc("cash_out"),
  beginHand: disc("begin_hand"),
  settleHand: disc("settle_hand"),
  emergencyTimeoutRefund: disc("emergency_timeout_refund"),
  withdrawRake: disc("withdraw_rake"),
  setPaused: disc("set_paused"),
  proposeOperator: disc("propose_operator"),
  acceptOperator: disc("accept_operator"),
} as const;

// ---------- Account discriminators ----------
function accountDisc(name: string): Buffer {
  return createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

export const ACCOUNT_DISC = {
  table: accountDisc("Table"),
  playerSeat: accountDisc("PlayerSeat"),
  settlementReceipt: accountDisc("SettlementReceipt"),
} as const;

// ---------- PDA derivations ----------
export function tablePda(id: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("table"), u64Le(id)],
    POKER_PROGRAM_ID,
  );
}

export function vaultPda(table: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [table.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function ataFor(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function seatPda(table: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("seat"), table.toBuffer(), player.toBuffer()],
    POKER_PROGRAM_ID,
  );
}

export function receiptPda(table: PublicKey, handId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), table.toBuffer(), u64Le(handId)],
    POKER_PROGRAM_ID,
  );
}

// ---------- Borsh schemas (account state) ----------
class TableState {
  id!: bigint;
  operator!: Uint8Array;
  tokenMint!: Uint8Array;
  tokenProgram!: Uint8Array;
  minBuyIn!: bigint;
  maxBuyIn!: bigint;
  smallBlind!: bigint;
  bigBlind!: bigint;
  rakeBps!: number;
  disputeWindowSlots!: bigint;
  rakeAccrued!: bigint;
  activeHandId!: bigint;
  bump!: number;
  constructor(fields: TableState) { Object.assign(this, fields); }
}

const TABLE_SCHEMA: borsh.Schema = {
  struct: {
    id: "u64",
    operator: { array: { type: "u8", len: 32 } },
    pendingOperator: { array: { type: "u8", len: 32 } },
    tokenMint: { array: { type: "u8", len: 32 } },
    tokenProgram: { array: { type: "u8", len: 32 } },
    minBuyIn: "u64",
    maxBuyIn: "u64",
    smallBlind: "u64",
    bigBlind: "u64",
    rakeBps: "u16",
    disputeWindowSlots: "u64",
    rakeAccrued: "u64",
    activeHandId: "u64",
    paused: "bool",
    bump: "u8",
  },
};

const SEAT_SCHEMA: borsh.Schema = {
  struct: {
    table: { array: { type: "u8", len: 32 } },
    player: { array: { type: "u8", len: 32 } },
    balance: "u64",
    lockedHandId: "u64",
    lockedAtSlot: "u64",
    lastActivitySlot: "u64",
    bump: "u8",
  },
};

const RECEIPT_SCHEMA: borsh.Schema = {
  struct: {
    table: { array: { type: "u8", len: 32 } },
    handId: "u64",
    potTotal: "u64",
    rake: "u64",
    settledAtSlot: "u64",
    bump: "u8",
  },
};

export type TableAccount = {
  id: bigint;
  operator: PublicKey;
  pendingOperator: PublicKey;
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  smallBlind: bigint;
  bigBlind: bigint;
  rakeBps: number;
  disputeWindowSlots: bigint;
  rakeAccrued: bigint;
  activeHandId: bigint;
  paused: boolean;
  bump: number;
};

export type SeatAccount = {
  table: PublicKey;
  player: PublicKey;
  balance: bigint;
  lockedHandId: bigint;
  lockedAtSlot: bigint;
  lastActivitySlot: bigint;
  bump: number;
};

export type ReceiptAccount = {
  table: PublicKey;
  handId: bigint;
  potTotal: bigint;
  rake: bigint;
  settledAtSlot: bigint;
  bump: number;
};

export function decodeTable(data: Uint8Array): TableAccount {
  assertDiscriminator(data, ACCOUNT_DISC.table, "Table");
  const decoded = borsh.deserialize(TABLE_SCHEMA, data.subarray(8)) as Record<string, unknown>;
  return {
    id: decoded.id as bigint,
    operator: new PublicKey(decoded.operator as Uint8Array),
    pendingOperator: new PublicKey(decoded.pendingOperator as Uint8Array),
    tokenMint: new PublicKey(decoded.tokenMint as Uint8Array),
    tokenProgram: new PublicKey(decoded.tokenProgram as Uint8Array),
    minBuyIn: decoded.minBuyIn as bigint,
    maxBuyIn: decoded.maxBuyIn as bigint,
    smallBlind: decoded.smallBlind as bigint,
    bigBlind: decoded.bigBlind as bigint,
    rakeBps: decoded.rakeBps as number,
    disputeWindowSlots: decoded.disputeWindowSlots as bigint,
    rakeAccrued: decoded.rakeAccrued as bigint,
    activeHandId: decoded.activeHandId as bigint,
    paused: decoded.paused as boolean,
    bump: decoded.bump as number,
  };
}

export function decodeSeat(data: Uint8Array): SeatAccount {
  assertDiscriminator(data, ACCOUNT_DISC.playerSeat, "PlayerSeat");
  const decoded = borsh.deserialize(SEAT_SCHEMA, data.subarray(8)) as Record<string, unknown>;
  return {
    table: new PublicKey(decoded.table as Uint8Array),
    player: new PublicKey(decoded.player as Uint8Array),
    balance: decoded.balance as bigint,
    lockedHandId: decoded.lockedHandId as bigint,
    lockedAtSlot: decoded.lockedAtSlot as bigint,
    lastActivitySlot: decoded.lastActivitySlot as bigint,
    bump: decoded.bump as number,
  };
}

export function decodeReceipt(data: Uint8Array): ReceiptAccount {
  assertDiscriminator(data, ACCOUNT_DISC.settlementReceipt, "SettlementReceipt");
  const decoded = borsh.deserialize(RECEIPT_SCHEMA, data.subarray(8)) as Record<string, unknown>;
  return {
    table: new PublicKey(decoded.table as Uint8Array),
    handId: decoded.handId as bigint,
    potTotal: decoded.potTotal as bigint,
    rake: decoded.rake as bigint,
    settledAtSlot: decoded.settledAtSlot as bigint,
    bump: decoded.bump as number,
  };
}

function assertDiscriminator(data: Uint8Array, expected: Buffer, name: string): void {
  if (data.length < 8) throw new Error(`account too short for ${name}`);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) throw new Error(`bad discriminator for ${name}`);
  }
}

// ---------- Instruction builders ----------

export type SeatDelta = {
  player: PublicKey;
  debit: bigint;
  credit: bigint;
};

export type InitializeTableArgs = {
  id: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  smallBlind: bigint;
  bigBlind: bigint;
  rakeBps: number;
  disputeWindowSlots: bigint;
};

export function ixInitializeTable(args: {
  operator: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
  params: InitializeTableArgs;
}): TransactionInstruction {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;
  const [table] = tablePda(args.params.id);
  const vault = vaultPda(table, args.tokenMint, tokenProgram);
  const data = Buffer.concat([
    IX.initializeTable,
    u64Le(args.params.id),
    u64Le(args.params.minBuyIn),
    u64Le(args.params.maxBuyIn),
    u64Le(args.params.smallBlind),
    u64Le(args.params.bigBlind),
    u16Le(args.params.rakeBps),
    u64Le(args.params.disputeWindowSlots),
  ]);
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.operator, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: args.tokenMint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function ixBuyIn(args: {
  player: PublicKey;
  table: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;
  const playerAta = ataFor(args.player, args.tokenMint, tokenProgram);
  const vault = vaultPda(args.table, args.tokenMint, tokenProgram);
  const [seat] = seatPda(args.table, args.player);
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.player, isSigner: true, isWritable: true },
      { pubkey: args.table, isSigner: false, isWritable: false },
      { pubkey: args.tokenMint, isSigner: false, isWritable: false },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.buyIn, u64Le(args.amount)]),
  });
}

export function ixCashOut(args: {
  player: PublicKey;
  table: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;
  const playerAta = ataFor(args.player, args.tokenMint, tokenProgram);
  const vault = vaultPda(args.table, args.tokenMint, tokenProgram);
  const [seat] = seatPda(args.table, args.player);
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.player, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: false },
      { pubkey: args.tokenMint, isSigner: false, isWritable: false },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.cashOut, u64Le(args.amount)]),
  });
}

export function ixBeginHand(args: {
  operator: PublicKey;
  table: PublicKey;
  handId: bigint;
  seats: PublicKey[];
}): TransactionInstruction {
  const remaining: AccountMeta[] = args.seats.map((s) => ({
    pubkey: s,
    isSigner: false,
    isWritable: true,
  }));
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.operator, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: true },
      ...remaining,
    ],
    data: Buffer.concat([IX.beginHand, u64Le(args.handId)]),
  });
}

export function ixSettleHand(args: {
  operator: PublicKey;
  table: PublicKey;
  handId: bigint;
  deltas: SeatDelta[];
  rake: bigint;
}): TransactionInstruction {
  const [receipt] = receiptPda(args.table, args.handId);
  const remaining: AccountMeta[] = args.deltas.map((d) => ({
    pubkey: seatPda(args.table, d.player)[0],
    isSigner: false,
    isWritable: true,
  }));
  // Vec<SeatDelta>: 4-byte LE length prefix, then each (32 + 8 + 8) bytes.
  const deltaBytes = Buffer.concat([
    u32Le(args.deltas.length),
    ...args.deltas.map((d) =>
      Buffer.concat([d.player.toBuffer(), u64Le(d.debit), u64Le(d.credit)]),
    ),
  ]);
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.operator, isSigner: true, isWritable: true },
      { pubkey: args.table, isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: Buffer.concat([
      IX.settleHand,
      u64Le(args.handId),
      deltaBytes,
      u64Le(args.rake),
    ]),
  });
}

export function ixEmergencyTimeoutRefund(args: {
  player: PublicKey;
  table: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;
  const playerAta = ataFor(args.player, args.tokenMint, tokenProgram);
  const vault = vaultPda(args.table, args.tokenMint, tokenProgram);
  const [seat] = seatPda(args.table, args.player);
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.player, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: false },
      { pubkey: args.tokenMint, isSigner: false, isWritable: false },
      { pubkey: playerAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: seat, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: IX.emergencyTimeoutRefund,
  });
}

export function ixWithdrawRake(args: {
  operator: PublicKey;
  table: PublicKey;
  tokenMint: PublicKey;
  treasuryAta: PublicKey;
  tokenProgram?: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;
  const vault = vaultPda(args.table, args.tokenMint, tokenProgram);
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.operator, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: true },
      { pubkey: args.tokenMint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: args.treasuryAta, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.withdrawRake, u64Le(args.amount)]),
  });
}

export function ixSetPaused(args: {
  operator: PublicKey;
  table: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.operator, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([IX.setPaused, Buffer.from([args.paused ? 1 : 0])]),
  });
}

export function ixProposeOperator(args: {
  operator: PublicKey;
  table: PublicKey;
  newOperator: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.operator, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([IX.proposeOperator, args.newOperator.toBuffer()]),
  });
}

export function ixAcceptOperator(args: {
  newOperator: PublicKey;
  table: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: POKER_PROGRAM_ID,
    keys: [
      { pubkey: args.newOperator, isSigner: true, isWritable: false },
      { pubkey: args.table, isSigner: false, isWritable: true },
    ],
    data: IX.acceptOperator,
  });
}

// ---------- Encoding helpers ----------

export function u64Le(n: bigint): Buffer {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

export function u32Le(n: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(n);
  return buf;
}

export function u16Le(n: number): Buffer {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16LE(n);
  return buf;
}
