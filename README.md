# Lightly

Texas Hold'em on Solana. USDC settlement. VRF-audited shuffles. Monorepo with a lean Anchor program, Hono+Bun API, Vite+React client, and Drizzle-backed off-chain state.

## Layout

```
apps/
  api/       Hono + Bun server (WS + hand engine + settlement worker)
  web/       Vite + React client (wallet-adapter, smooth animated felt)
packages/
  idl/       Hand-rolled Anchor IDL helpers (discriminators, PDAs, borsh, ix builders)
  db/        Drizzle schema + migrations
  shared/    Cards, VRF-seeded shuffle, 7-card evaluator, wire protocol
programs/
  poker/     Anchor program (Rust) + LiteSVM TS tests
```

## Program

7 instructions, all privileged ones guarded by `has_one = operator`:

| ix | signer | purpose |
|---|---|---|
| `initialize_table` | operator | Create table PDA + vault ATA |
| `buy_in` | player | Deposit USDC → seat balance |
| `cash_out` | player | Withdraw from unlocked seat |
| `begin_hand` | operator | Lock N seats for a monotonic `hand_id` |
| `settle_hand` | operator | Atomic payout; asserts `sum(debits) == sum(credits) + rake`; creates `SettlementReceipt` PDA (replay-safe via `init`) |
| `emergency_timeout_refund` | player | Unilateral refund if operator leaves a seat locked past `dispute_window_slots` |
| `withdraw_rake` | operator | Sweep accrued rake to treasury ATA |

Custody model: semi-custodial. Operator has settle authority; players always have the unilateral refund backstop.

## Tests

20/20 LiteSVM tests in `programs/poker/tests/poker.test.ts`. Run:

```bash
bun install
cd programs/poker/tests && bun test
```

Covers every instruction's happy path, attack paths (wrong signer, replay, locked-seat cash_out, rake cap, pot math), and the conservation invariant across 5 hands.

## Local dev

### Prereqs

- `solana` CLI 3.x (includes `cargo-build-sbf`)
- `surfpool` (`cargo install surfpool-cli --locked`)
- `bun` ≥ 1.2

### Build the program

```bash
cargo-build-sbf
# artifact: target/deploy/poker.so
# program id: 9FeibPV2hjbkcu4YHSnUMr9ikWV7QLWMmBpVFZAcYsZH
```

### Run a local validator (surfpool)

Surfpool boots a mainnet-cloning local validator and deploys the program automatically using `Surfpool.toml`:

```bash
surfpool start
# RPC: http://127.0.0.1:8899
# WS:  ws://127.0.0.1:8900
# USDC mint (classic SPL, cloned): EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### Run the stack

```bash
bun install
bun --filter @lightly/api dev      # API on :4000
bun --filter @lightly/web dev      # Vite on :5173, proxies /api and /ws
```

Open http://localhost:5173, connect Phantom/Solflare, click **Start hand**.

## Security notes

- `overflow-checks = true` in release profile + `checked_add`/`checked_sub` on every money line.
- `Account<'info, T>` everywhere — Anchor enforces owner = program ID.
- `Interface<'info, TokenInterface>` pins the token program for CPIs.
- `init` on `SettlementReceipt` makes replay impossible: two settlements for the same `hand_id` collide on PDA init.
- Monotonic `hand_id` prevents stale settle + rebegin.
- Time-based expiry uses slots, not wall clock.
- Mints with `transfer_hook` / confidential transfers / frozen-default are rejected by spec — stick to classic USDC/USDT for MVP.

## Fairness

- Dealer draws a 32-byte seed per hand (dev: `crypto.getRandomValues`; prod: ORAO VRF).
- `sha256(seed)` is published as a commitment before any card is dealt (shown in UI).
- On showdown the seed is revealed; clients can re-derive the deck via `shuffleDeck(seed)` from `@lightly/shared`.

## Roadmap to real launch

- Replace dev seed with ORAO VRF on-chain call.
- Wire settlement worker to submit `begin_hand` + `settle_hand` via Helius Sender (Jito-bundled for frontrun protection).
- Swap operator authority to a Squads v4 multisig.
- LaserStream subscription on program ID → reconcile `HandSettled` events into `settlements` table.
- Helius webhook on vault ATA → reconcile buy-in/cash-out into `ledger`.
- MagicBlock ephemeral rollup for sub-slot action latency on high-volume tables.

See the research reports for the full 2026 stack rationale.
