/**
 * Engine correctness tests — focus on the anti-cheat / payout invariants.
 */
import { describe, test, expect } from "bun:test";
import { HoldemEngine, type HandOutcome, type TableConfig } from "../src/engine.ts";
import type { ServerEvent } from "@lightly/shared";

function makeEngine(): { engine: HoldemEngine; outcomes: HandOutcome[]; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const outcomes: HandOutcome[] = [];
  const config: TableConfig = {
    tableId: "t",
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    minBuyIn: 100,
    maxBuyIn: 10_000,
    rakeBps: 0, // disable rake for easier math in these tests
    actionTimeoutMs: 5_000,
  };
  const engine = new HoldemEngine({
    config,
    randomSeed: () => {
      // Deterministic seed for reproducibility across runs.
      const buf = new Uint8Array(32);
      for (let i = 0; i < 32; i++) buf[i] = i + 1;
      return buf;
    },
    emit: (e) => events.push(e),
    onHandComplete: (o) => outcomes.push(o),
  });
  return { engine, outcomes, events };
}

describe("hold'em engine — invariants", () => {
  test("conservation: sum(debits) == sum(credits) + rake for every hand", async () => {
    const { engine, outcomes } = makeEngine();
    engine.seatPlayer("A", 500);
    engine.seatPlayer("B", 500);
    engine.seatPlayer("C", 500);

    await engine.startHand();
    // Everyone calls, everyone checks to showdown.
    // Preflop: UTG (seat after BB) = seat 0 → call, then seat 1 (SB) → call, seat 2 (BB) checks.
    // Actually with 3 handed: dealer=0 (first hand sets dealer to seat 1 via nextSeatFrom(-1)).
    // For simplicity just drive the engine by actions and see if it completes.
    //
    // Safer: call a cycle. Engine calls act(wallet, ...). We just keep calling "call"
    // on whoever is to-act until the street advances. Continue to showdown.
    const allActed = new Set<string>();
    let safety = 0;
    while (safety++ < 200) {
      const v = engine.view("A");
      if (v.toActSeat === null) break;
      const seat = v.seats.find((s) => s.seatIndex === v.toActSeat);
      if (!seat?.wallet) break;
      engine.act(seat.wallet, "call");
      allActed.add(seat.wallet);
    }

    expect(outcomes.length).toBe(1);
    const o = outcomes[0]!;
    const totalDebit = o.deltas.reduce((a, d) => a + d.debit, 0);
    const totalCredit = o.deltas.reduce((a, d) => a + d.credit, 0);
    expect(totalDebit).toBe(totalCredit + o.rake);
  });

  test("all-in short stack can't overpay — side pot math is correct", async () => {
    const { engine, outcomes } = makeEngine();
    engine.seatPlayer("Short", 20);   // will be all-in
    engine.seatPlayer("Big1", 500);
    engine.seatPlayer("Big2", 500);

    await engine.startHand();

    // Everyone calls to set a pot.
    let safety = 0;
    while (safety++ < 200) {
      const v = engine.view("Short");
      if (v.toActSeat === null) break;
      const seat = v.seats.find((s) => s.seatIndex === v.toActSeat);
      if (!seat?.wallet) break;
      engine.act(seat.wallet, "call");
    }

    expect(outcomes.length).toBe(1);
    const o = outcomes[0]!;
    // No one's credit can exceed the total everyone contributed to the sub-pot
    // they were eligible for. The short stack, if they win, can at most win
    // their_contribution * 3. They put in 20, so max credit = 60.
    const shortDelta = o.deltas.find((d) => d.wallet === "Short")!;
    expect(shortDelta.credit).toBeLessThanOrEqual(60);
    // Conservation still holds.
    const totalDebit = o.deltas.reduce((a, d) => a + d.debit, 0);
    const totalCredit = o.deltas.reduce((a, d) => a + d.credit, 0);
    expect(totalDebit).toBe(totalCredit + o.rake);
  });

  test("folding removes you from contention; committed chips stay in pot", async () => {
    const { engine, outcomes } = makeEngine();
    engine.seatPlayer("A", 500);
    engine.seatPlayer("B", 500);
    engine.seatPlayer("C", 500);

    await engine.startHand();
    // Whoever acts first folds, then everyone else keeps calling/checking to showdown.
    const v0 = engine.view("A");
    const first = v0.seats.find((s) => s.seatIndex === v0.toActSeat)!;
    engine.act(first.wallet, "fold");
    let safety = 0;
    while (safety++ < 200) {
      const v = engine.view("A");
      if (v.toActSeat === null) break;
      const seat = v.seats.find((s) => s.seatIndex === v.toActSeat);
      if (!seat?.wallet) break;
      engine.act(seat.wallet, "call");
    }

    expect(outcomes.length).toBe(1);
    const o = outcomes[0]!;
    const totalDebit = o.deltas.reduce((a, d) => a + d.debit, 0);
    const totalCredit = o.deltas.reduce((a, d) => a + d.credit, 0);
    expect(totalDebit).toBe(totalCredit + o.rake);
    // The folder may or may not appear in deltas depending on whether they posted
    // a blind; if they do appear, they must have been credited 0 (lost).
    const folderDelta = o.deltas.find((d) => d.wallet === first.wallet);
    if (folderDelta) expect(folderDelta.credit).toBe(0);
  });

  test("leave-safe: requestLeave during hand folds you, preserves pot", async () => {
    const { engine, outcomes } = makeEngine();
    engine.seatPlayer("A", 500);
    engine.seatPlayer("B", 500);

    await engine.startHand();
    // A requests leave mid-hand.
    engine.requestLeave("A");

    // After A folds, B wins by fold. Hand should complete.
    expect(outcomes.length).toBe(1);
    const o = outcomes[0]!;
    const totalDebit = o.deltas.reduce((a, d) => a + d.debit, 0);
    const totalCredit = o.deltas.reduce((a, d) => a + d.credit, 0);
    expect(totalDebit).toBe(totalCredit + o.rake);
  });
});
