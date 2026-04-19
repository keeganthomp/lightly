/**
 * Texas Hold'em engine — one instance per table.
 *
 * Authoritative server-side state machine. The chain doesn't see this; only
 * the net deltas at settle-time do. Dealing is VRF-seeded and committed via
 * sha256 before hole cards go out → players can audit post-hand.
 */
import {
  type Card,
  evaluate7,
  seedCommit,
  shuffleDeck,
  type Street,
  type TableView,
  type ServerEvent,
  type SeatView,
  type HandRank,
} from "@lightly/shared";

export type Seat = {
  index: number;
  wallet: string;
  stack: number;
  committedThisStreet: number;
  committedThisHand: number;
  hole: [Card, Card] | null;
  folded: boolean;
  allIn: boolean;
  actedThisStreet: boolean;
  sitting: boolean;
  connected: boolean;
};

export type TableConfig = {
  tableId: string;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  rakeBps: number;
  actionTimeoutMs: number;
};

export type HandOutcome = {
  handId: number;
  seedHex: string;
  vrfProof: string;
  commitHashHex: string;
  deltas: Array<{ wallet: string; debit: number; credit: number }>;
  rake: number;
  winners: Array<{ seat: number; amount: number }>;
  reveals: Array<{ seat: number; hole: [Card, Card]; rank: HandRank }>;
};

type EngineOpts = {
  config: TableConfig;
  /**
   * Source of randomness. In dev we take the first 32 bytes of a CSPRNG and
   * treat it as a "VRF proof" for audit purposes; in prod wire to ORAO/Switchboard.
   */
  randomSeed: () => Uint8Array;
  emit: (event: ServerEvent) => void;
  /**
   * Called once the hand ends. The API worker takes the outcome and submits
   * begin_hand + settle_hand to the chain, then emits `settled`.
   */
  onHandComplete: (outcome: HandOutcome) => void;
};

export class HoldemEngine {
  private seats: Seat[];
  private handId = 0;
  private dealer = -1;
  private street: Street = "idle";
  private board: Card[] = [];
  private deck: Card[] = [];
  private currentBet = 0;
  private minRaiseTo = 0;
  private pot = 0;
  private toAct: number | null = null;
  private deadlineMs = 0;
  private commitHashHex = "";
  private seedHex = "";
  private vrfProof = "";

  constructor(private opts: EngineOpts) {
    this.seats = Array.from({ length: opts.config.maxSeats }, (_, i) => ({
      index: i,
      wallet: "",
      stack: 0,
      committedThisStreet: 0,
      committedThisHand: 0,
      hole: null,
      folded: true,
      allIn: false,
      actedThisStreet: false,
      sitting: false,
      connected: false,
    }));
  }

  // ---------- Seat management ----------

  seatPlayer(wallet: string, stack: number): number {
    const empty = this.seats.find((s) => !s.sitting);
    if (!empty) throw new Error("table full");
    empty.wallet = wallet;
    empty.stack = stack;
    empty.sitting = true;
    empty.connected = true;
    empty.folded = true;
    return empty.index;
  }

  setConnected(wallet: string, connected: boolean): void {
    const s = this.seats.find((s) => s.wallet === wallet && s.sitting);
    if (s) s.connected = connected;
  }

  leaveSeat(wallet: string): void {
    const s = this.seats.find((s) => s.wallet === wallet && s.sitting);
    if (s) {
      s.sitting = false;
      s.wallet = "";
      s.stack = 0;
      s.hole = null;
    }
  }

  activeSeats(): Seat[] {
    return this.seats.filter((s) => s.sitting && s.stack > 0);
  }

  view(forWallet: string): TableView {
    const you = this.seats.findIndex((s) => s.wallet === forWallet);
    return {
      tableId: this.opts.config.tableId,
      handId: this.handId,
      street: this.street,
      dealerSeat: this.dealer,
      toActSeat: this.toAct,
      board: this.board,
      pot: this.pot,
      minRaiseTo: this.minRaiseTo,
      currentBet: this.currentBet,
      deadline: this.deadlineMs,
      you,
      commitHash: this.commitHashHex,
      seats: this.seats.map<SeatView>((s) => ({
        seatIndex: s.index,
        wallet: s.wallet,
        stack: s.stack,
        committed: s.committedThisStreet,
        hole: s.index === you ? s.hole : null,
        folded: s.folded,
        allIn: s.allIn,
        actedThisStreet: s.actedThisStreet,
        sitting: s.sitting,
        connected: s.connected,
      })),
    };
  }

  // ---------- Hand lifecycle ----------

  async startHand(): Promise<void> {
    const active = this.activeSeats();
    if (active.length < 2) throw new Error("need 2+ players");
    this.handId += 1;
    this.dealer = this.nextSeatFrom(this.dealer, active);
    this.pot = 0;
    this.currentBet = this.opts.config.bigBlind;
    this.minRaiseTo = this.opts.config.bigBlind * 2;
    this.board = [];
    this.street = "preflop";

    const seed = this.opts.randomSeed();
    this.seedHex = Buffer.from(seed).toString("hex");
    this.vrfProof = this.seedHex;
    const commit = await seedCommit(seed);
    this.commitHashHex = Buffer.from(commit).toString("hex");
    this.deck = shuffleDeck(seed);

    for (const s of this.seats) {
      if (!s.sitting || s.stack <= 0) {
        s.hole = null;
        s.folded = true;
        continue;
      }
      s.hole = [this.deck.pop()!, this.deck.pop()!];
      s.folded = false;
      s.allIn = false;
      s.committedThisStreet = 0;
      s.committedThisHand = 0;
      s.actedThisStreet = false;
    }

    // Blinds
    const sbSeat = this.nextSeatFrom(this.dealer, active);
    const bbSeat = this.nextSeatFrom(sbSeat, active);
    this.postBlind(sbSeat, this.opts.config.smallBlind);
    this.postBlind(bbSeat, this.opts.config.bigBlind);

    this.opts.emit({
      kind: "hand_start",
      handId: this.handId,
      dealerSeat: this.dealer,
      commitHash: this.commitHashHex,
    });

    // First to act preflop = seat after BB.
    this.toAct = this.nextSeatFrom(bbSeat, active);
    this.armTimer();
  }

  private postBlind(seatIdx: number, amount: number): void {
    const s = this.seats[seatIdx]!;
    const put = Math.min(amount, s.stack);
    s.stack -= put;
    s.committedThisStreet += put;
    s.committedThisHand += put;
    this.pot += put;
    if (s.stack === 0) s.allIn = true;
  }

  private armTimer(): void {
    this.deadlineMs = Date.now() + this.opts.config.actionTimeoutMs;
    if (this.toAct === null) return;
    const s = this.seats[this.toAct]!;
    this.opts.emit({
      kind: "to_act",
      seat: this.toAct,
      deadline: this.deadlineMs,
      minRaiseTo: this.minRaiseTo,
      callAmount: Math.max(0, this.currentBet - s.committedThisStreet),
    });
  }

  // ---------- Actions ----------

  act(wallet: string, action: "fold" | "check" | "call" | "bet" | "raise", amount?: number): void {
    if (this.toAct === null) throw new Error("no active hand");
    const s = this.seats[this.toAct];
    if (!s || s.wallet !== wallet) throw new Error("not your turn");

    const toCall = this.currentBet - s.committedThisStreet;

    switch (action) {
      case "fold": {
        s.folded = true;
        break;
      }
      case "check": {
        if (toCall > 0) throw new Error("cannot check facing a bet");
        break;
      }
      case "call": {
        const put = Math.min(toCall, s.stack);
        s.stack -= put;
        s.committedThisStreet += put;
        s.committedThisHand += put;
        this.pot += put;
        if (s.stack === 0) s.allIn = true;
        break;
      }
      case "bet": {
        if (this.currentBet > 0) throw new Error("cannot bet facing a bet — use raise");
        if (!amount || amount < this.opts.config.bigBlind) throw new Error("bet below minimum");
        const put = Math.min(amount, s.stack);
        s.stack -= put;
        s.committedThisStreet += put;
        s.committedThisHand += put;
        this.pot += put;
        this.currentBet = s.committedThisStreet;
        this.minRaiseTo = this.currentBet + put;
        if (s.stack === 0) s.allIn = true;
        // Reset acted flags for everyone else.
        for (const other of this.activeSeats()) if (other.index !== s.index) other.actedThisStreet = false;
        break;
      }
      case "raise": {
        if (!amount || amount < this.minRaiseTo) throw new Error(`raise to must be >= ${this.minRaiseTo}`);
        const delta = amount - s.committedThisStreet;
        const put = Math.min(delta, s.stack);
        s.stack -= put;
        s.committedThisStreet += put;
        s.committedThisHand += put;
        this.pot += put;
        const raiseSize = s.committedThisStreet - this.currentBet;
        this.currentBet = s.committedThisStreet;
        this.minRaiseTo = this.currentBet + raiseSize;
        if (s.stack === 0) s.allIn = true;
        for (const other of this.activeSeats()) if (other.index !== s.index) other.actedThisStreet = false;
        break;
      }
    }
    s.actedThisStreet = true;
    this.opts.emit({ kind: "action", seat: s.index, action, ...(amount ? { amount } : {}) });
    this.advance();
  }

  // ---------- Street progression ----------

  private advance(): void {
    const active = this.activeSeats().filter((s) => !s.folded);
    if (active.length === 1) {
      this.goToShowdown(true);
      return;
    }
    const unsettled = active.filter(
      (s) => !s.allIn && (!s.actedThisStreet || s.committedThisStreet < this.currentBet),
    );
    if (unsettled.length > 0) {
      this.toAct = this.nextSeatFrom(this.toAct ?? this.dealer, active);
      this.armTimer();
      return;
    }
    // Everyone settled this street.
    this.nextStreet();
  }

  private nextStreet(): void {
    for (const s of this.seats) {
      s.committedThisStreet = 0;
      s.actedThisStreet = false;
    }
    this.currentBet = 0;
    this.minRaiseTo = this.opts.config.bigBlind;

    switch (this.street) {
      case "preflop":
        this.street = "flop";
        this.board.push(this.deck.pop()!, this.deck.pop()!, this.deck.pop()!);
        break;
      case "flop":
        this.street = "turn";
        this.board.push(this.deck.pop()!);
        break;
      case "turn":
        this.street = "river";
        this.board.push(this.deck.pop()!);
        break;
      case "river":
        this.goToShowdown(false);
        return;
      default:
        return;
    }
    this.opts.emit({ kind: "street", street: this.street, board: [...this.board] });
    // First to act postflop = next live seat after dealer.
    const active = this.activeSeats().filter((s) => !s.folded && !s.allIn);
    if (active.length === 0) {
      this.nextStreet();
      return;
    }
    this.toAct = this.nextSeatFrom(this.dealer, active);
    this.armTimer();
  }

  private goToShowdown(wonByFold: boolean): void {
    this.street = "showdown";
    this.toAct = null;
    const contenders = this.seats.filter((s) => s.sitting && !s.folded);
    const reveals: Array<{ seat: number; hole: [Card, Card]; rank: HandRank }> = [];
    for (const c of contenders) {
      if (!c.hole) continue;
      const rank = wonByFold
        ? { score: 0, category: "Win by fold", best5: [...c.hole] as Card[] }
        : evaluate7([...c.hole, ...this.board]);
      reveals.push({ seat: c.index, hole: c.hole, rank });
    }

    // Pot + side-pot math (simple: single-pot or chop between equal-rank contenders).
    const sorted = reveals.slice().sort((a, b) => b.rank.score - a.rank.score);
    const top = sorted[0]!.rank.score;
    const winners = sorted.filter((r) => r.rank.score === top);
    const rake = Math.floor((this.pot * this.opts.config.rakeBps) / 10_000);
    const payable = this.pot - rake;
    const per = Math.floor(payable / winners.length);
    const rem = payable - per * winners.length; // award remainder to first winner

    const winnerSeats = winners.map((w, i) => ({ seat: w.seat, amount: per + (i === 0 ? rem : 0) }));

    // Build deltas: every contender was debited what they committed this hand.
    const deltas = this.seats
      .filter((s) => s.sitting && s.committedThisHand > 0)
      .map((s) => {
        const credit = winnerSeats.find((w) => w.seat === s.index)?.amount ?? 0;
        return { wallet: s.wallet, debit: s.committedThisHand, credit };
      });

    this.opts.emit({
      kind: "showdown",
      reveals,
      seed: this.seedHex,
      vrfProof: this.vrfProof,
    });

    this.opts.onHandComplete({
      handId: this.handId,
      seedHex: this.seedHex,
      vrfProof: this.vrfProof,
      commitHashHex: this.commitHashHex,
      deltas,
      rake,
      winners: winnerSeats,
      reveals,
    });

    // Apply the credits locally so subsequent hands have updated stacks
    for (const w of winnerSeats) {
      const seat = this.seats[w.seat]!;
      seat.stack += w.amount;
    }
    this.street = "idle";
    this.toAct = null;
  }

  private nextSeatFrom(from: number, among: Seat[]): number {
    const n = this.opts.config.maxSeats;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (among.some((s) => s.index === idx && !s.folded && s.stack > 0)) return idx;
    }
    return -1;
  }
}
