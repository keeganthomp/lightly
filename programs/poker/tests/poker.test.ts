/**
 * Comprehensive poker program tests.
 *
 *   Happy paths:  every instruction runs end-to-end
 *   Invariants:   token conservation, pot math, rake accounting
 *   Attack paths: wrong signer, replay, locked seat, rake cap, etc.
 *
 * All in-process LiteSVM — fast enough to expand further without CI pain.
 */
import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  POKER_PROGRAM_ID,
  ataFor,
  ixBeginHand,
  ixBuyIn,
  ixCashOut,
  ixEmergencyTimeoutRefund,
  ixInitializeTable,
  ixSettleHand,
  ixWithdrawRake,
  receiptPda,
  seatPda,
  tablePda,
} from "@lightly/idl";
import {
  anchorErr,
  assertFailure,
  assertSuccess,
  bootstrap,
  isFailed,
} from "./setup";

const DEFAULT_PARAMS = {
  minBuyIn: 10_000_000n, // 10 USDC
  maxBuyIn: 1_000_000_000n, // 1000 USDC
  smallBlind: 100_000n, // 0.1 USDC
  bigBlind: 200_000n,
  rakeBps: 250, // 2.5%
  disputeWindowSlots: 1_000n,
};

function initTable(h: ReturnType<typeof bootstrap>, id = 1n) {
  const [table] = tablePda(id);
  const res = h.send(
    [
      ixInitializeTable({
        operator: h.operator.publicKey,
        tokenMint: h.mint,
        params: { id, ...DEFAULT_PARAMS },
      }),
    ],
    [h.operator],
  );
  assertSuccess(res, `initTable id=${id}`);
  return table;
}

describe("initialize_table", () => {
  test("creates table + vault ATA with operator as authority", () => {
    const h = bootstrap();
    const table = initTable(h);
    const t = h.fetchTable(table);
    expect(t.id).toBe(1n);
    expect(t.operator.equals(h.operator.publicKey)).toBe(true);
    expect(t.tokenMint.equals(h.mint)).toBe(true);
    expect(t.rakeBps).toBe(DEFAULT_PARAMS.rakeBps);
    expect(t.rakeAccrued).toBe(0n);
    expect(t.activeHandId).toBe(0n);
  });

  test("rejects rake > 10%", () => {
    const h = bootstrap();
    const res = h.send(
      [
        ixInitializeTable({
          operator: h.operator.publicKey,
          tokenMint: h.mint,
          params: { id: 99n, ...DEFAULT_PARAMS, rakeBps: 1001 },
        }),
      ],
      [h.operator],
    );
    // RakeTooHigh = ordinal 2
    assertFailure(res, anchorErr(2));
  });

  test("rejects big_blind < small_blind", () => {
    const h = bootstrap();
    const res = h.send(
      [
        ixInitializeTable({
          operator: h.operator.publicKey,
          tokenMint: h.mint,
          params: { id: 2n, ...DEFAULT_PARAMS, smallBlind: 500n, bigBlind: 100n },
        }),
      ],
      [h.operator],
    );
    // InvalidConfig = ordinal 1
    assertFailure(res, anchorErr(1));
  });

  test("rejects duplicate table id", () => {
    const h = bootstrap();
    initTable(h, 42n);
    const res = h.send(
      [
        ixInitializeTable({
          operator: h.operator.publicKey,
          tokenMint: h.mint,
          params: { id: 42n, ...DEFAULT_PARAMS },
        }),
      ],
      [h.operator],
    );
    // Anchor/system collision on the init PDA
    expect(isFailed(res)).toBe(true);
  });
});

describe("buy_in", () => {
  test("deposits to vault, credits seat, updates balance", () => {
    const h = bootstrap();
    const table = initTable(h);
    const player = h.players[0]!;
    const playerAta = ataFor(player.publicKey, h.mint);
    const before = h.tokenBalance(playerAta);

    const amount = 500_000_000n;
    const res = h.send(
      [ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount })],
      [player],
    );
    assertSuccess(res, "buy_in");

    const [seat] = seatPda(table, player.publicKey);
    const s = h.fetchSeat(seat);
    expect(s.balance).toBe(amount);
    expect(s.player.equals(player.publicKey)).toBe(true);
    expect(s.table.equals(table)).toBe(true);
    expect(s.lockedHandId).toBe(0n);

    expect(h.tokenBalance(playerAta)).toBe(before - amount);
  });

  test("rejects below min_buy_in", () => {
    const h = bootstrap();
    const table = initTable(h);
    const res = h.send(
      [
        ixBuyIn({
          player: h.players[0]!.publicKey,
          table,
          tokenMint: h.mint,
          amount: 1n,
        }),
      ],
      [h.players[0]!],
    );
    // BuyInTooSmall = ordinal 3
    assertFailure(res, anchorErr(3));
  });

  test("rejects above max_buy_in even across multiple buy_ins", () => {
    const h = bootstrap();
    const table = initTable(h);
    const player = h.players[0]!;
    // First fills to 900 USDC
    assertSuccess(
      h.send(
        [ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount: 900_000_000n })],
        [player],
      ),
    );
    // Second would push past 1000 USDC cap
    const res = h.send(
      [ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount: 200_000_000n })],
      [player],
    );
    // BuyInTooLarge = ordinal 4
    assertFailure(res, anchorErr(4));
  });

  test("additive buy-ins accumulate in seat balance", () => {
    const h = bootstrap();
    const table = initTable(h);
    const player = h.players[0]!;
    for (let i = 0; i < 3; i++) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
          [player],
        ),
      );
    }
    const [seat] = seatPda(table, player.publicKey);
    expect(h.fetchSeat(seat).balance).toBe(300_000_000n);
  });
});

describe("cash_out", () => {
  test("returns sats to player ATA, decrements seat", () => {
    const h = bootstrap();
    const table = initTable(h);
    const player = h.players[0]!;
    const playerAta = ataFor(player.publicKey, h.mint);
    assertSuccess(
      h.send(
        [ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount: 500_000_000n })],
        [player],
      ),
    );
    const before = h.tokenBalance(playerAta);

    assertSuccess(
      h.send(
        [ixCashOut({ player: player.publicKey, table, tokenMint: h.mint, amount: 200_000_000n })],
        [player],
      ),
    );
    expect(h.tokenBalance(playerAta)).toBe(before + 200_000_000n);
    const [seat] = seatPda(table, player.publicKey);
    expect(h.fetchSeat(seat).balance).toBe(300_000_000n);
  });

  test("fails if seat is locked mid-hand", () => {
    const h = bootstrap();
    const table = initTable(h);
    const [p1, p2] = [h.players[0]!, h.players[1]!];
    for (const p of [p1, p2]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 500_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2].map((p) => seatPda(table, p.publicKey)[0]);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );
    const res = h.send(
      [ixCashOut({ player: p1.publicKey, table, tokenMint: h.mint, amount: 100n })],
      [p1],
    );
    // SeatLocked = ordinal 7
    assertFailure(res, anchorErr(7));
  });

  test("fails on insufficient balance", () => {
    const h = bootstrap();
    const table = initTable(h);
    const player = h.players[0]!;
    assertSuccess(
      h.send(
        [ixBuyIn({ player: player.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
        [player],
      ),
    );
    const res = h.send(
      [ixCashOut({ player: player.publicKey, table, tokenMint: h.mint, amount: 999_999_999n })],
      [player],
    );
    // InsufficientBalance = ordinal 6
    assertFailure(res, anchorErr(6));
  });
});

describe("begin_hand + settle_hand full cycle", () => {
  test("atomic settlement: debits == credits + rake, seats unlock, receipt created", () => {
    const h = bootstrap({ numPlayers: 3 });
    const table = initTable(h);
    const [p1, p2, p3] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];

    // Each buys in 200 USDC
    for (const p of [p1, p2, p3]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 200_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2, p3].map((p) => seatPda(table, p.publicKey)[0]);

    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );
    for (const s of seats) {
      expect(h.fetchSeat(s).lockedHandId).toBe(1n);
    }

    // Hand outcome:
    //   p1 commits 20 USDC, p2 commits 50 USDC, p3 commits 30 USDC → pot = 100 USDC
    //   rake = 2.5 USDC (2.5%), winner = p2 gets 97.5 USDC
    const rake = 2_500_000n;
    const deltas = [
      { player: p1.publicKey, debit: 20_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 50_000_000n, credit: 97_500_000n },
      { player: p3.publicKey, debit: 30_000_000n, credit: 0n },
    ];
    assertSuccess(
      h.send(
        [ixSettleHand({ operator: h.operator.publicKey, table, handId: 1n, deltas, rake })],
        [h.operator],
      ),
    );

    // Balance checks
    expect(h.fetchSeat(seats[0]!).balance).toBe(180_000_000n);
    expect(h.fetchSeat(seats[1]!).balance).toBe(247_500_000n);
    expect(h.fetchSeat(seats[2]!).balance).toBe(170_000_000n);

    // All unlocked
    for (const s of seats) {
      expect(h.fetchSeat(s).lockedHandId).toBe(0n);
    }

    // Receipt exists and is correct
    const [receipt] = receiptPda(table, 1n);
    const r = h.fetchReceipt(receipt);
    expect(r.handId).toBe(1n);
    expect(r.potTotal).toBe(100_000_000n);
    expect(r.rake).toBe(2_500_000n);

    // Rake accrued
    expect(h.fetchTable(table).rakeAccrued).toBe(2_500_000n);
  });

  test("rejects settlement where debits != credits + rake", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = initTable(h);
    const [p1, p2] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];
    for (const p of [p1, p2]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2].map((p) => seatPda(table, p.publicKey)[0]);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );
    // Wrong math: debits=30, credits+rake=25
    const deltas = [
      { player: p1.publicKey, debit: 20_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 10_000_000n, credit: 25_000_000n },
    ];
    const res = h.send(
      [ixSettleHand({ operator: h.operator.publicKey, table, handId: 1n, deltas, rake: 0n })],
      [h.operator],
    );
    // PotMismatch = ordinal 14
    assertFailure(res, anchorErr(14));
  });

  test("rejects double-settle of same hand_id (replay protection)", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = initTable(h);
    const [p1, p2] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];
    for (const p of [p1, p2]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2].map((p) => seatPda(table, p.publicKey)[0]);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 7n, seats })],
        [h.operator],
      ),
    );
    const deltas = [
      { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
    ];
    assertSuccess(
      h.send(
        [ixSettleHand({ operator: h.operator.publicKey, table, handId: 7n, deltas, rake: 0n })],
        [h.operator],
      ),
    );
    // Re-begin the same hand_id — should fail monotonic check
    const res1 = h.send(
      [ixBeginHand({ operator: h.operator.publicKey, table, handId: 7n, seats })],
      [h.operator],
    );
    // HandIdNotMonotonic = ordinal 17
    assertFailure(res1, anchorErr(17));
  });

  test("rejects settle_hand from non-operator", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = initTable(h);
    const [p1, p2] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];
    for (const p of [p1, p2]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2].map((p) => seatPda(table, p.publicKey)[0]);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );
    const deltas = [
      { player: p1.publicKey, debit: 10_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 10_000_000n, credit: 20_000_000n },
    ];
    // p1 tries to impersonate operator
    const res = h.send(
      [ixSettleHand({ operator: p1.publicKey, table, handId: 1n, deltas, rake: 0n })],
      [p1],
    );
    expect(isFailed(res)).toBe(true);
  });
});

describe("emergency_timeout_refund", () => {
  test("returns full seat balance after dispute window elapses", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = initTable(h);
    const [p1, p2] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];
    const playerAta = ataFor(p1.publicKey, h.mint);
    for (const p of [p1, p2]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 500_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2].map((p) => seatPda(table, p.publicKey)[0]);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );
    const before = h.tokenBalance(playerAta);

    // Before window elapses, refund should fail.
    const early = h.send(
      [ixEmergencyTimeoutRefund({ player: p1.publicKey, table, tokenMint: h.mint })],
      [p1],
    );
    // DisputeWindowActive = ordinal 20
    assertFailure(early, anchorErr(20));

    // Warp past the dispute window.
    h.warpSlots(DEFAULT_PARAMS.disputeWindowSlots + 1n);

    assertSuccess(
      h.send(
        [ixEmergencyTimeoutRefund({ player: p1.publicKey, table, tokenMint: h.mint })],
        [p1],
      ),
    );
    expect(h.tokenBalance(playerAta)).toBe(before + 500_000_000n);
    expect(h.fetchSeat(seats[0]!).balance).toBe(0n);
    expect(h.fetchSeat(seats[0]!).lockedHandId).toBe(0n);
  });

  test("fails when seat is not locked", () => {
    const h = bootstrap({ numPlayers: 1 });
    const table = initTable(h);
    const p1 = h.players[0]!;
    assertSuccess(
      h.send(
        [ixBuyIn({ player: p1.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
        [p1],
      ),
    );
    h.warpSlots(DEFAULT_PARAMS.disputeWindowSlots + 10n);
    const res = h.send(
      [ixEmergencyTimeoutRefund({ player: p1.publicKey, table, tokenMint: h.mint })],
      [p1],
    );
    // SeatNotLocked = ordinal 8
    assertFailure(res, anchorErr(8));
  });
});

describe("withdraw_rake", () => {
  test("operator sweeps accrued rake to treasury ATA", () => {
    const h = bootstrap({ numPlayers: 2 });
    const table = initTable(h);
    const [p1, p2] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];
    for (const p of [p1, p2]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2].map((p) => seatPda(table, p.publicKey)[0]);
    assertSuccess(
      h.send(
        [ixBeginHand({ operator: h.operator.publicKey, table, handId: 1n, seats })],
        [h.operator],
      ),
    );
    // Pot=40 USDC, rake=1 USDC (2.5%)
    const deltas = [
      { player: p1.publicKey, debit: 20_000_000n, credit: 0n },
      { player: p2.publicKey, debit: 20_000_000n, credit: 39_000_000n },
    ];
    assertSuccess(
      h.send(
        [ixSettleHand({ operator: h.operator.publicKey, table, handId: 1n, deltas, rake: 1_000_000n })],
        [h.operator],
      ),
    );

    const beforeTreasury = h.tokenBalance(h.treasuryAta);
    assertSuccess(
      h.send(
        [
          ixWithdrawRake({
            operator: h.operator.publicKey,
            table,
            tokenMint: h.mint,
            treasuryAta: h.treasuryAta,
            amount: 1_000_000n,
          }),
        ],
        [h.operator],
      ),
    );
    expect(h.tokenBalance(h.treasuryAta)).toBe(beforeTreasury + 1_000_000n);
    expect(h.fetchTable(table).rakeAccrued).toBe(0n);
  });

  test("rejects rake withdraw > accrued", () => {
    const h = bootstrap();
    const table = initTable(h);
    const res = h.send(
      [
        ixWithdrawRake({
          operator: h.operator.publicKey,
          table,
          tokenMint: h.mint,
          treasuryAta: h.treasuryAta,
          amount: 1n,
        }),
      ],
      [h.operator],
    );
    // InsufficientRake = ordinal 21
    assertFailure(res, anchorErr(21));
  });
});

describe("invariants", () => {
  test("token conservation: vault balance == sum of seat balances + accrued rake", () => {
    const h = bootstrap({ numPlayers: 3 });
    const table = initTable(h);
    const [p1, p2, p3] = h.players as [import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair, import("@solana/web3.js").Keypair];

    for (const p of [p1, p2, p3]) {
      assertSuccess(
        h.send(
          [ixBuyIn({ player: p.publicKey, table, tokenMint: h.mint, amount: 100_000_000n })],
          [p],
        ),
      );
    }
    const seats = [p1, p2, p3].map((p) => seatPda(table, p.publicKey)[0]);

    // Run 5 hands with random-ish outcomes; conservation must hold after each.
    for (let i = 1; i <= 5; i++) {
      assertSuccess(
        h.send(
          [ixBeginHand({ operator: h.operator.publicKey, table, handId: BigInt(i), seats })],
          [h.operator],
        ),
      );
      const pot = 30_000_000n; // everyone puts in 10 USDC
      const rake = 750_000n; // 2.5% of 30
      const winnerIdx = i % 3;
      const deltas = [0, 1, 2].map((idx) => ({
        player: [p1, p2, p3][idx]!.publicKey,
        debit: 10_000_000n,
        credit: idx === winnerIdx ? pot - rake : 0n,
      }));
      assertSuccess(
        h.send(
          [ixSettleHand({ operator: h.operator.publicKey, table, handId: BigInt(i), deltas, rake })],
          [h.operator],
        ),
      );

      const seatSum =
        h.fetchSeat(seats[0]!).balance +
        h.fetchSeat(seats[1]!).balance +
        h.fetchSeat(seats[2]!).balance;
      const rakeAccrued = h.fetchTable(table).rakeAccrued;
      // Derive vault ATA from PDA
      const vaultOwner = table;
      const vaultAta = PublicKey.findProgramAddressSync(
        [vaultOwner.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), h.mint.toBuffer()],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      )[0];
      const vaultBal = h.tokenBalance(vaultAta);
      expect(seatSum + rakeAccrued).toBe(vaultBal);
    }
  });
});
