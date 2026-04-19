#!/usr/bin/env bun
/**
 * One-shot local bootstrap. Assumes surfpool (or any local validator) is
 * running at $RPC_URL (default http://127.0.0.1:8899).
 *
 * Does:
 *   1. Ensures operator wallet has SOL (airdrop).
 *   2. Creates a fresh SPL mint (6 decimals) as our dev "USDC".
 *   3. Initializes table id=$TABLE_ID on-chain with that mint.
 *   4. Creates ATAs for the operator and any test wallet paths passed in argv.
 *   5. Mints a bunch of dev-USDC to each of them.
 *   6. Prints the env vars the API + UI should use.
 *
 * Usage:
 *   bun run scripts/bootstrap.ts [--players=5] [--amount=1000]
 *   bun run scripts/bootstrap.ts --player=<wallet>  # fund a specific wallet
 *
 * Env:
 *   RPC_URL                 - default http://127.0.0.1:8899
 *   OPERATOR_KEYPAIR_PATH   - default ~/.config/solana/id.json
 *   TABLE_ID                - default 1
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ataFor,
  ixInitializeTable,
  tablePda,
} from "@lightly/idl";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const OPERATOR_KEYPAIR_PATH =
  process.env.OPERATOR_KEYPAIR_PATH ?? `${homedir()}/.config/solana/id.json`;
const TABLE_ID = BigInt(process.env.TABLE_ID ?? "1");
const MINT_KEYPAIR_PATH = `${process.cwd()}/.bootstrap/mint.json`;

// ---------- argv ----------
const argv = process.argv.slice(2);
const getArg = (k: string): string | null => {
  const m = argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=").slice(1).join("=") : null;
};
const specificPlayer = getArg("player");
const amountArg = getArg("amount") ?? "1000"; // default 1000 dev-USDC

// ---------- helpers ----------

function loadKeypair(path: string): Keypair {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")));
  return Keypair.fromSecretKey(bytes);
}

function saveKeypair(path: string, kp: Keypair): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
}

function ensureOperator(): Keypair {
  if (existsSync(OPERATOR_KEYPAIR_PATH)) return loadKeypair(OPERATOR_KEYPAIR_PATH);
  const fresh = Keypair.generate();
  saveKeypair(OPERATOR_KEYPAIR_PATH, fresh);
  console.log(`  new operator keypair → ${OPERATOR_KEYPAIR_PATH}`);
  return fresh;
}

async function airdrop(c: Connection, to: PublicKey, sol: number): Promise<void> {
  const sig = await c.requestAirdrop(to, sol * 1_000_000_000);
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
  await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
}

const MINT_SIZE = 82;

async function createMint(
  c: Connection,
  payer: Keypair,
  authority: PublicKey,
  decimals: number,
): Promise<PublicKey> {
  // Reuse the mint if we already created one on a prior run.
  if (existsSync(MINT_KEYPAIR_PATH)) {
    const kp = loadKeypair(MINT_KEYPAIR_PATH);
    const info = await c.getAccountInfo(kp.publicKey);
    if (info) {
      console.log(`  reusing mint → ${kp.publicKey.toBase58()}`);
      return kp.publicKey;
    }
  }
  const mint = Keypair.generate();
  saveKeypair(MINT_KEYPAIR_PATH, mint);

  const lamports = await c.getMinimumBalanceForRentExemption(MINT_SIZE);
  const create = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID,
  });
  const init = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
    // initializeMint2: disc 20, decimals u8, authority 32, freeze_option u8(0)
    data: Buffer.concat([
      Buffer.from([20]),
      Buffer.from([decimals]),
      authority.toBuffer(),
      Buffer.from([0]),
    ]),
  });
  const tx = new Transaction().add(create, init);
  await sendAndConfirmTransaction(c, tx, [payer, mint]);
  console.log(`  new mint → ${mint.publicKey.toBase58()}`);
  return mint.publicKey;
}

async function createAtaIfMissing(
  c: Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey,
): Promise<PublicKey> {
  const ata = ataFor(owner, mint);
  const info = await c.getAccountInfo(ata);
  if (info) return ata;
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
  await sendAndConfirmTransaction(c, new Transaction().add(ix), [payer]);
  return ata;
}

async function mintTo(
  c: Connection,
  payer: Keypair,
  mintAuth: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  amount: bigint,
): Promise<void> {
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(amount);
  const ix = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: mintAuth.publicKey, isSigner: true, isWritable: false },
    ],
    // mintTo: disc 7, amount u64
    data: Buffer.concat([Buffer.from([7]), amt]),
  });
  await sendAndConfirmTransaction(c, new Transaction().add(ix), [payer, mintAuth]);
}

async function tableExists(c: Connection, table: PublicKey): Promise<boolean> {
  const info = await c.getAccountInfo(table);
  return !!info;
}

// ---------- main ----------

async function main(): Promise<void> {
  console.log(`▲ lightly bootstrap`);
  console.log(`  rpc: ${RPC_URL}`);
  const c = new Connection(RPC_URL, "confirmed");
  const operator = ensureOperator();
  console.log(`  operator: ${operator.publicKey.toBase58()}`);

  const bal = await c.getBalance(operator.publicKey);
  if (bal < 1_000_000_000) {
    console.log(`  airdropping 10 SOL to operator…`);
    await airdrop(c, operator.publicKey, 10);
  }

  const mint = await createMint(c, operator, operator.publicKey, 6);

  const [table] = tablePda(TABLE_ID);
  if (!(await tableExists(c, table))) {
    console.log(`  initializing table id=${TABLE_ID}…`);
    const ix = ixInitializeTable({
      operator: operator.publicKey,
      tokenMint: mint,
      params: {
        id: TABLE_ID,
        minBuyIn: 10_000_000n,        // 10 dev-USDC
        maxBuyIn: 1_000_000_000n,     // 1000 dev-USDC
        smallBlind: 100_000n,
        bigBlind: 200_000n,
        rakeBps: 250,
        disputeWindowSlots: 1000n,
      },
    });
    await sendAndConfirmTransaction(c, new Transaction().add(ix), [operator]);
    console.log(`  table PDA → ${table.toBase58()}`);
  } else {
    console.log(`  table already exists → ${table.toBase58()}`);
  }

  // Funding
  const amount = BigInt(amountArg) * 1_000_000n;
  const recipients: PublicKey[] = [operator.publicKey];
  if (specificPlayer) recipients.push(new PublicKey(specificPlayer));

  for (const r of recipients) {
    const ata = await createAtaIfMissing(c, operator, r, mint);
    await mintTo(c, operator, operator, mint, ata, amount);
    console.log(`  funded ${r.toBase58()} with ${amountArg} dev-USDC (ata ${ata.toBase58()})`);
  }

  console.log(`\n✓ ready. Copy these into apps/api/.env:\n`);
  console.log(`RPC_URL=${RPC_URL}`);
  console.log(`OPERATOR_KEYPAIR_PATH=${OPERATOR_KEYPAIR_PATH}`);
  console.log(`TABLE_ID=${TABLE_ID}`);
  console.log(`\nAnd these into apps/web/.env:\n`);
  console.log(`VITE_RPC_URL=${RPC_URL}`);
  console.log(`VITE_MINT=${mint.toBase58()}`);
  console.log(`VITE_TABLE_PDA=${table.toBase58()}`);
  console.log(`VITE_TABLE_ID=${TABLE_ID}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
