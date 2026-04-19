/**
 * Drizzle schema — off-chain state.
 *
 * The Anchor program is the source of truth for money. This DB mirrors what's
 * needed off-chain for matchmaking, hand history, auth, and reconciliation of
 * on-chain settlement signatures.
 */
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wallet: text("wallet").notNull().unique(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at"),
  },
);

export const tables = pgTable(
  "tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    onchainTableId: bigint("onchain_table_id", { mode: "bigint" })
      .notNull()
      .unique(),
    tablePda: text("table_pda").notNull(),
    mint: text("mint").notNull(),
    smallBlind: bigint("small_blind", { mode: "bigint" }).notNull(),
    bigBlind: bigint("big_blind", { mode: "bigint" }).notNull(),
    minBuyIn: bigint("min_buy_in", { mode: "bigint" }).notNull(),
    maxBuyIn: bigint("max_buy_in", { mode: "bigint" }).notNull(),
    rakeBps: integer("rake_bps").notNull(),
    maxSeats: integer("max_seats").notNull().default(9),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

export const hands = pgTable(
  "hands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id")
      .references(() => tables.id, { onDelete: "cascade" })
      .notNull(),
    handNumber: bigint("hand_number", { mode: "bigint" }).notNull(),
    vrfProof: text("vrf_proof").notNull(),
    seedHash: text("seed_hash").notNull(),
    board: jsonb("board"),
    potMsat: bigint("pot_msat", { mode: "bigint" }).notNull().default(0n),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [uniqueIndex("hand_unique").on(t.tableId, t.handNumber)],
);

export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handId: uuid("hand_id")
      .references(() => hands.id, { onDelete: "cascade" })
      .notNull(),
    seq: integer("seq").notNull(),
    wallet: text("wallet").notNull(),
    street: text("street").notNull(),
    kind: text("kind").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull().default(0n),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("actions_hand_seq").on(t.handId, t.seq)],
);

export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handId: uuid("hand_id")
      .references(() => hands.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    txSig: text("tx_sig").notNull().unique(),
    status: text("status").notNull(), // pending | confirmed | finalized | failed
    payouts: jsonb("payouts").notNull(),
    rake: bigint("rake", { mode: "bigint" }).notNull().default(0n),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    finalizedAt: timestamp("finalized_at"),
  },
);

export const ledger = pgTable(
  "ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").notNull(), // buy_in | cash_out | win | loss | rake
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    tableId: uuid("table_id").references(() => tables.id),
    txSig: text("tx_sig"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("ledger_user").on(t.userId, t.createdAt)],
);
