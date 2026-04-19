/**
 * Adversarial test suite.
 *
 * Each test encodes an attack an operator or player might try and asserts the
 * program stops it. This is the "how could we get rekt" catalog, not the
 * happy-path coverage (that lives in `poker.test.ts`).
 */
import { describe, test, expect } from "bun:test";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNT_DISC,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  IX,
  POKER_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ataFor,
  ixAcceptOperator,
  ixBeginHand,
  ixBuyIn,
  ixCashOut,
  ixEmergencyTimeoutRefund,
  ixInitializeTable,
  ixProposeOperator,
  ixSetPaused,
  ixSettleHand,
  ixWithdrawRake,
  receiptPda,
  seatPda,
  tablePda,
  u32Le,
  u64Le,
} from "@lightly/idl";
import {
  anchorErr,
  assertFailure,
  assertSuccess,
  bootstrap,
  isFailed,
  type Harness,
} from "./setup";

const DEFAULTS = {
  minBuyIn: 10_000_000n,
  maxBuyIn: 1_000_000_000n,
  smallBlind: 100_000n,
  bigBlind: 200_000n,
  rakeBps: 250,
  disputeWindowSlots: 1_000n,
};

function init(h: Harness, id = 1n, overrides: Partial<typeof DEFAULTS> = {}) {
  const [table] = tablePda(id);
  const params = { id, ...DEFAULTS, ...overrides };
  const res = h.send(
    [ixInitializeTable({ operator: h.operator.publicKey, tokenMint: h.mint, params })],
    [h.operator],
  );
  assertSuccess(res, "initTable");
  return table;
}

function buyIn(h: Harness, table: PublicKey, player: Keypair, amount: bigint): PublicKey {
  assertSuccess(
    h.send([ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount })], [player]),
  );
  return seatPda(table, player.publicKey)[0];
}

// ---------- Settlement attack vectors ----------

describe("settle_hand: attack surface", () => {
  test("passing the SAME seat twice in remaining_accounts is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    buyIn(h, table, p2, 100_000_000n);
    const seats = [seat1, seatPda(table, p2.publicKey)[0]];
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );

    // Build a settle_hand where BOTH remaining_accounts entries point to seat1.
    // First loop iteration clears seat1's lock; second iteration must fail.
    const ix = ixSettleHand({
      operator: h.operator.publicKey,
      table,
      handId: 1n,
      deltas: [
        { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
        { player: p1.publicKey, debit: 10_000_000n, credit: 20_000_000n },
      ],
      rake: 0n,
    });
    // Override the remaining_accounts (last two keys) to duplicate seat1.
    const rewritten = new TransactionInstruction({
      programId: ix.programId,
      data: ix.data,
      keys: [
        ...ix.keys.slice(0, 4), // operator, table, receipt, system_program
        { pubkey: seat1, isSigner: false, isWritable: true },
        { pubkey: seat1, isSigner: false, isWritable: true },
      ],
    });
    const res = h.send([rewritten], [h.operator]);
    // SeatNotLockedForHand = ordinal 10 (the lock is cleared after first pass)
    assertFailure(res, anchorErr(10));
  });

  test("passing a SettlementReceipt account where a PlayerSeat is expected is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    buyIn(h, table, p1, 100_000_000n);
    buyIn(h, table, p2, 100_000_000n);
    const seat1 = seatPda(table, p1.publicKey)[0];
    const seat2 = seatPda(table, p2.publicKey)[0];
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    // Settle hand 1 cleanly to mint a SettlementReceipt we can then misuse.
    assertSuccess(
      h.send(
        [
          ixSettleHand({
            operator: h.operator.publicKey,
            table,
            handId: 1n,
            deltas: [
              { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
              { player: p1.publicKey, debit: 0n, credit: 0n } /* filler */,
              { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
            ].filter((_, i) => i !== 1),
            rake: 0n,
          }),
        ],
        [h.operator],
      ),
    );

    // Begin hand 2, then try to settle with a receipt PDA passed as a "seat".
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 2n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    const [receipt1] = receiptPda(table, 1n);
    const bogusIx = ixSettleHand({
      operator: h.operator.publicKey,
      table,
      handId: 2n,
      deltas: [
        { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
        { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
      ],
      rake: 0n,
    });
    // Overwrite second remaining_accounts entry with receipt1 instead of seat2.
    const rewritten = new TransactionInstruction({
      programId: bogusIx.programId,
      data: bogusIx.data,
      keys: [
        ...bogusIx.keys.slice(0, 4),
        bogusIx.keys[4]!,
        { pubkey: receipt1, isSigner: false, isWritable: true },
      ],
    });
    const res = h.send([rewritten], [h.operator]);
    // Discriminator mismatch — Anchor's Account::try_from rejects
    expect(isFailed(res)).toBe(true);
  });

  test("passing a seat from a DIFFERENT table is rejected (cross-table theft attempt)", () => {
    const h = bootstrap({ numPlayers: 2 });
    const tableA = init(h, 1n);
    const tableB = init(h, 2n);
    const [p1, p2] = h.players as [Keypair, Keypair];
    // Player 1 is in both tables.
    buyIn(h, tableA, p1, 100_000_000n);
    buyIn(h, tableB, p1, 100_000_000n);
    buyIn(h, tableA, p2, 100_000_000n);

    const seatA_p1 = seatPda(tableA, p1.publicKey)[0];
    const seatB_p1 = seatPda(tableB, p1.publicKey)[0];
    const seatA_p2 = seatPda(tableA, p2.publicKey)[0];

    assertSuccess(
      h.send(
        [
          ixBeginHand({
            operator: h.operator.publicKey,
            table: tableA,
            handId: 1n,
            seats: [seatA_p1, seatA_p2],
          }),
        ],
        [h.operator],
      ),
    );

    // Try to settle tableA hand 1, but swap seatA_p1 for seatB_p1 — same player,
    // different table. Must be rejected.
    const ix = ixSettleHand({
      operator: h.operator.publicKey,
      table: tableA,
      handId: 1n,
      deltas: [
        { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
        { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
      ],
      rake: 0n,
    });
    const rewritten = new TransactionInstruction({
      programId: ix.programId,
      data: ix.data,
      keys: [
        ...ix.keys.slice(0, 4),
        { pubkey: seatB_p1, isSigner: false, isWritable: true }, // cross-table!
        { pubkey: seatA_p2, isSigner: false, isWritable: true },
      ],
    });
    const res = h.send([rewritten], [h.operator]);
    // WrongTable = ordinal 11
    assertFailure(res, anchorErr(11));
  });

  test("credits > debits (even with rake=0) is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    const res = h.send(
      [
        ixSettleHand({
          operator: h.operator.publicKey,
          table,
          handId: 1n,
          deltas: [
            { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
            { player: p2.publicKey, debit: 10_000_000n, credit: 999_999_999n },
          ],
          rake: 0n,
        }),
      ],
      [h.operator],
    );
    // PotMismatch = ordinal 14
    assertFailure(res, anchorErr(14));
  });

  test("debit > seat balance is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 10_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    const res = h.send(
      [
        ixSettleHand({
          operator: h.operator.publicKey,
          table,
          handId: 1n,
          deltas: [
            { player: p1.publicKey, debit: 999_999_999n, credit: 0n }, // > seat balance
            { player: p2.publicKey, debit: 10_000_000n, credit: 0n },
          ],
          rake: 0n,
        }),
      ],
      [h.operator],
    );
    // InsufficientBalance = ordinal 6
    assertFailure(res, anchorErr(6));
  });

  test("replay a completed hand via init-collision on SettlementReceipt", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 5n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    const deltas = [
      { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
    ];
    assertSuccess(
      h.send(
        [ixSettleHand({ operator: h.operator.publicKey, table, handId: 5n, deltas, rake: 0n })],
        [h.operator],
      ),
    );
    // Try to settle hand 5 again — receipt PDA already exists; init fails.
    const res = h.send(
      [ixSettleHand({ operator: h.operator.publicKey, table, handId: 5n, deltas, rake: 0n })],
      [h.operator],
    );
    expect(isFailed(res)).toBe(true);
  });

  test("hand_id equal to active_hand_id is rejected (strictly monotonic)", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);

    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    assertSuccess(
      h.send(
        [
          ixSettleHand({
            operator: h.operator.publicKey,
            table,
            handId: 1n,
            deltas: [
              { player: p1.publicKey, debit: 0n, credit: 0n },
              { player: p2.publicKey, debit: 0n, credit: 0n },
            ],
            rake: 0n,
          }),
        ],
        [h.operator],
      ),
    );
    const res = h.send(
      [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
      [h.operator],
    );
    // HandIdNotMonotonic = ordinal 17
    assertFailure(res, anchorErr(17));
  });

  test("hand_id = 0 is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    const res = h.send(
      [ixBeginHand({ operator: h.operator.publicKey, table, handId: 0n, seats: [seat1, seat2] })],
      [h.operator],
    );
    // InvalidHandId = ordinal 16
    assertFailure(res, anchorErr(16));
  });

  test("begin_hand with 0 seats is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const res = h.send(
      [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [] })],
      [h.operator],
    );
    // NoSeats = ordinal 18
    assertFailure(res, anchorErr(18));
  });

  test("begin_hand with a seat that has balance = 0 is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 10_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    // p1 cashes out entire balance → seat balance = 0.
    assertSuccess(
      h.send(
        [ixCashOut({ player: p1.publicKey, table, tokenMint: h.mint, amount: 10_000_000n })],
        [p1],
      ),
    );
    const res = h.send(
      [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
      [h.operator],
    );
    // EmptySeat = ordinal 13
    assertFailure(res, anchorErr(13));
  });

  test("begin_hand locking an already-locked seat is rejected (double-book protection)", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    // Without settling hand 1, try to begin hand 2 with the same seats.
    const res = h.send(
      [ixBeginHand({ operator: h.operator.publicKey, table, handId: 2n, seats: [seat1, seat2] })],
      [h.operator],
    );
    // SeatAlreadyLocked = ordinal 9
    assertFailure(res, anchorErr(9));
  });
});

// ---------- Signer / authority attacks ----------

describe("authority checks", () => {
  test("non-operator cannot call begin_hand", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    const res = h.send(
      [ixBeginHand({ operator: p1.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
      [p1],
    );
    expect(isFailed(res)).toBe(true);
  });

  test("non-operator cannot withdraw_rake", () => {
    const h = bootstrap();
    const table = init(h);
    const p1 = h.players[0]!;
    const res = h.send(
      [
        ixWithdrawRake({
          operator: p1.publicKey,
          table,
          tokenMint: h.mint,
          treasuryAta: h.treasuryAta,
          amount: 1n,
        }),
      ],
      [p1],
    );
    expect(isFailed(res)).toBe(true);
  });

  test("non-operator cannot propose_operator", () => {
    const h = bootstrap();
    const table = init(h);
    const rogue = Keypair.generate();
    h.svm.airdrop(rogue.publicKey, 1_000_000_000n);
    const res = h.send(
      [
        ixProposeOperator({
          operator: rogue.publicKey,
          table,
          newOperator: rogue.publicKey,
        }),
      ],
      [rogue],
    );
    expect(isFailed(res)).toBe(true);
  });

  test("cash_out cannot be called by a wallet that isn't the seat owner", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    buyIn(h, table, p1, 100_000_000n);
    buyIn(h, table, p2, 50_000_000n);
    // p2 tries to cash_out p1's seat.
    const ix = ixCashOut({ player: p2.publicKey, table, tokenMint: h.mint, amount: 10_000_000n });
    // But the seat PDA in the ix is derived from the `player` arg (p2), so this is
    // actually hitting p2's seat. To properly attempt theft, forge the seat pubkey:
    const seat1 = seatPda(table, p1.publicKey)[0];
    const forged = new TransactionInstruction({
      programId: ix.programId,
      data: ix.data,
      keys: [
        ix.keys[0]!, // player (p2 signer)
        ix.keys[1]!, // table
        ix.keys[2]!, // mint
        { pubkey: ataFor(p2.publicKey, h.mint), isSigner: false, isWritable: true },
        ix.keys[4]!, // vault
        { pubkey: seat1, isSigner: false, isWritable: true }, // p1's seat!
        ix.keys[6]!, // token_program
      ],
    });
    const res = h.send([forged], [p2]);
    // has_one = player fails: seat.player (p1) != player arg (p2)
    expect(isFailed(res)).toBe(true);
  });

  test("emergency_timeout_refund cannot be triggered by a non-owner signer", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    h.warpSlots(DEFAULTS.disputeWindowSlots + 1n);
    // p2 tries to refund p1's seat by signing with their own key but forging the seat.
    const ix = ixEmergencyTimeoutRefund({ player: p2.publicKey, table, tokenMint: h.mint });
    const forged = new TransactionInstruction({
      programId: ix.programId,
      data: ix.data,
      keys: [
        ix.keys[0]!, // p2 signer
        ix.keys[1]!, // table
        ix.keys[2]!, // mint
        { pubkey: ataFor(p2.publicKey, h.mint), isSigner: false, isWritable: true },
        ix.keys[4]!, // vault
        { pubkey: seat1, isSigner: false, isWritable: true }, // p1's seat
        ix.keys[6]!, // token_program
      ],
    });
    const res = h.send([forged], [p2]);
    // has_one = player fails
    expect(isFailed(res)).toBe(true);
  });
});

// ---------- Operator rotation races ----------

describe("operator rotation edge cases", () => {
  test("accept_operator with no prior propose (pending is default pubkey) is rejected", () => {
    const h = bootstrap();
    const table = init(h);
    const attacker = Keypair.generate();
    h.svm.airdrop(attacker.publicKey, 1_000_000_000n);
    const res = h.send(
      [ixAcceptOperator({ newOperator: attacker.publicKey, table })],
      [attacker],
    );
    // NotPendingOperator = ordinal 24
    assertFailure(res, anchorErr(24));
  });

  test("propose_operator can be overwritten by a subsequent propose — only latest can accept", () => {
    const h = bootstrap();
    const table = init(h);
    const newA = Keypair.generate();
    const newB = Keypair.generate();
    h.svm.airdrop(newA.publicKey, 1_000_000_000n);
    h.svm.airdrop(newB.publicKey, 1_000_000_000n);

    assertSuccess(
      h.send(
        [ixProposeOperator({ operator: h.operator.publicKey, table, newOperator: newA.publicKey })],
        [h.operator],
      ),
    );
    assertSuccess(
      h.send(
        [ixProposeOperator({ operator: h.operator.publicKey, table, newOperator: newB.publicKey })],
        [h.operator],
      ),
    );
    // newA should not be able to accept now.
    const resA = h.send([ixAcceptOperator({ newOperator: newA.publicKey, table })], [newA]);
    assertFailure(resA, anchorErr(24));
    // newB can.
    assertSuccess(h.send([ixAcceptOperator({ newOperator: newB.publicKey, table })], [newB]));
    expect(h.fetchTable(table).operator.equals(newB.publicKey)).toBe(true);
  });

  test("after operator rotation, old operator's settle_hand on an active hand fails", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    // Old operator starts a hand.
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    // Rotate to new operator.
    const newOp = Keypair.generate();
    h.svm.airdrop(newOp.publicKey, 1_000_000_000n);
    assertSuccess(
      h.send(
        [ixProposeOperator({ operator: h.operator.publicKey, table, newOperator: newOp.publicKey })],
        [h.operator],
      ),
    );
    assertSuccess(h.send([ixAcceptOperator({ newOperator: newOp.publicKey, table })], [newOp]));

    // Old operator tries to finish the hand. has_one check fails.
    const deltas = [
      { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
    ];
    const res = h.send(
      [ixSettleHand({ operator: h.operator.publicKey, table, handId: 1n, deltas, rake: 0n })],
      [h.operator],
    );
    expect(isFailed(res)).toBe(true);

    // New operator can finish the active hand.
    assertSuccess(
      h.send(
        [ixSettleHand({ operator: newOp.publicKey, table, handId: 1n, deltas, rake: 0n })],
        [newOp],
      ),
    );
  });
});

// ---------- Rake cap edges ----------

describe("rake cap edges", () => {
  test("rake one satoshi above cap is rejected", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h); // rakeBps = 250 → cap 2.5%
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    // pot = 40 USDC; cap = 1 USDC.
    // Attempt rake = 1.000001 USDC.
    const res = h.send(
      [
        ixSettleHand({
          operator: h.operator.publicKey,
          table,
          handId: 1n,
          deltas: [
            { player: p1.publicKey, debit: 20_000_000n, credit: 0n },
            { player: p2.publicKey, debit: 20_000_000n, credit: 38_999_999n },
          ],
          rake: 1_000_001n,
        }),
      ],
      [h.operator],
    );
    // RakeExceedsCap = ordinal 22
    assertFailure(res, anchorErr(22));
  });

  test("rake = 0 is always allowed regardless of cap", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h, 99n, { rakeBps: 0 });
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    assertSuccess(
      h.send(
        [
          ixSettleHand({
            operator: h.operator.publicKey,
            table,
            handId: 1n,
            deltas: [
              { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
              { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
            ],
            rake: 0n,
          }),
        ],
        [h.operator],
      ),
    );
  });
});

// ---------- initialize_table restrictions ----------

describe("initialize_table restrictions", () => {
  test("rake_bps at exactly the cap (1000) is allowed", () => {
    const h = bootstrap();
    const [table] = tablePda(42n);
    assertSuccess(
      h.send(
        [
          ixInitializeTable({
            operator: h.operator.publicKey,
            tokenMint: h.mint,
            params: { id: 42n, ...DEFAULTS, rakeBps: 1000 },
          }),
        ],
        [h.operator],
      ),
    );
    expect(h.fetchTable(table).rakeBps).toBe(1000);
  });

  test("initialize_table with wrong token_program is rejected (MVP: classic SPL only)", () => {
    const h = bootstrap();
    // Send a forged initialize_table where token_program is the Token-2022 program.
    const bogusTokenProgram = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const [table] = tablePda(7n);
    const vault = PublicKey.findProgramAddressSync(
      [table.toBuffer(), bogusTokenProgram.toBuffer(), h.mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
    const data = Buffer.concat([
      IX.initializeTable,
      u64Le(7n),
      u64Le(DEFAULTS.minBuyIn),
      u64Le(DEFAULTS.maxBuyIn),
      u64Le(DEFAULTS.smallBlind),
      u64Le(DEFAULTS.bigBlind),
      Buffer.from([DEFAULTS.rakeBps & 0xff, (DEFAULTS.rakeBps >> 8) & 0xff]),
      u64Le(DEFAULTS.disputeWindowSlots),
    ]);
    const ix = new TransactionInstruction({
      programId: POKER_PROGRAM_ID,
      keys: [
        { pubkey: h.operator.publicKey, isSigner: true, isWritable: true },
        { pubkey: table, isSigner: false, isWritable: true },
        { pubkey: h.mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: bogusTokenProgram, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data,
    });
    const res = h.send([ix], [h.operator]);
    expect(isFailed(res)).toBe(true);
  });
});

// ---------- Pause semantics ----------

describe("pause semantics", () => {
  test("emergency_timeout_refund still works while paused", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    assertSuccess(
      h.send(
        [ixSetPaused({ operator: h.operator.publicKey, table, paused: true })],
        [h.operator],
      ),
    );
    h.warpSlots(DEFAULTS.disputeWindowSlots + 1n);
    // Paused table must still let players refund — it's a safety net, not a brake.
    assertSuccess(
      h.send(
        [ixEmergencyTimeoutRefund({ player: p1.publicKey, table, tokenMint: h.mint })],
        [p1],
      ),
    );
  });

  test("settle_hand still works while paused (for mid-hand cleanup)", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    // Pause mid-hand (e.g. bug discovered).
    assertSuccess(
      h.send(
        [ixSetPaused({ operator: h.operator.publicKey, table, paused: true })],
        [h.operator],
      ),
    );
    // Settle still goes through — operator can close out the active hand cleanly.
    assertSuccess(
      h.send(
        [
          ixSettleHand({
            operator: h.operator.publicKey,
            table,
            handId: 1n,
            deltas: [
              { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
              { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
            ],
            rake: 0n,
          }),
        ],
        [h.operator],
      ),
    );
  });
});

// ---------- Cash-out griefing ----------

describe("cash_out races", () => {
  test("cash_out during a locked seat does NOT leak funds; only emergency unlocks", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = init(h);
    const [p1, p2] = h.players as [Keypair, Keypair];
    const seat1 = buyIn(h, table, p1, 100_000_000n);
    const seat2 = buyIn(h, table, p2, 100_000_000n);
    const vaultBefore = h.tokenBalance(
      PublicKey.findProgramAddressSync(
        [table.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), h.mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )[0],
    );
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats: [seat1, seat2] })],
        [h.operator],
      ),
    );
    const res = h.send(
      [ixCashOut({ player: p1.publicKey, table, tokenMint: h.mint, amount: 100n })],
      [p1],
    );
    // SeatLocked = ordinal 7
    assertFailure(res, anchorErr(7));
    // Vault untouched.
    const vaultAfter = h.tokenBalance(
      PublicKey.findProgramAddressSync(
        [table.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), h.mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )[0],
    );
    expect(vaultAfter).toBe(vaultBefore);
  });
});
