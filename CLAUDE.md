# CLAUDE.md — session onboarding

> Read this top-to-bottom before touching code. It's short. It's the state of the project.

## What Lightly is

A Texas Hold'em poker web app settled on Solana in USDC. Money lives on-chain in an Anchor program; game logic (dealing, betting, hand eval) runs off-chain in a Hono+Bun API. The Anchor program only handles escrow + authorized payout.

## Repo layout

```
apps/
  api/       Hono + Bun. WS game loop + HTTP + SIWS auth + chain-submit worker.
  web/       Vite + React. Wallet-adapter, animated felt, signed deposit/withdraw.
packages/
  idl/       Hand-rolled Anchor IDL (precomputed discriminators, PDAs, borsh, ix builders). Browser-safe (uses `buffer` npm).
  shared/    Cards, VRF-seeded deterministic shuffle, 7-card evaluator, zod wire protocol.
  db/        Drizzle schema (users/tables/hands/actions/settlements/ledger). Not wired into API yet — in-memory for now.
programs/
  poker/     Anchor 0.31.1 program. 10 instructions. Full test suite in tests/.
scripts/
  bootstrap.ts   Create mint, initialize_table, fund wallets on localnet.
```

## Program (the source of truth for money)

- `declare_id!("9FeibPV2hjbkcu4YHSnUMr9ikWV7QLWMmBpVFZAcYsZH")` — keypair in `programs/poker/keys/poker-keypair.json`.
- 10 instructions. Signer model:
  - **operator** (has_one): `initialize_table`, `begin_hand`, `settle_hand`, `withdraw_rake`, `set_paused`, `propose_operator`
  - **player** (signer + seed): `buy_in`, `cash_out`, `emergency_timeout_refund`
  - **pending_operator** (signer + field match): `accept_operator`
- Accounts: `Table`, `PlayerSeat`, `SettlementReceipt`. All PDAs.
- Key invariants (if any of these regresses, tests will fail):
  - `sum(seat.balance) + rake_accrued == vault_ata_balance` (conservation)
  - `sum(debits) == sum(credits) + rake` on every settle_hand
  - `rake <= pot_total * rake_bps / 10000` — **CRITICAL, added in audit round 2**. Without this the operator can confiscate the pot.
  - Monotonic `hand_id`: next > active
  - Replay protection: `SettlementReceipt` uses `init` (not `init_if_needed`)
  - `buy_in` rejects deposits into locked seats
- Token-2022 is **rejected at `initialize_table`** in the current build. Classic SPL only. This is an explicit safety choice (avoid PermanentDelegate / TransferFee / DefaultAccountState=Frozen / hooks).

## Tests — 58 total, all passing

```bash
bun test   # run from repo root
```

- `programs/poker/tests/poker.test.ts` — 28 happy-path + invariant tests
- `programs/poker/tests/adversarial.test.ts` — 26 attack-path tests (cross-table, type confusion, duplicate seat, rotation races, rake-cap edges, token-program allowlist)
- `apps/api/tests/engine.test.ts` — 4 engine invariants (conservation, side-pot correctness, leave-safe)

If you change program semantics, **adversarial tests must all still pass**. They're the red team.

## Local dev (end-to-end)

Prereqs: `solana` CLI 3.x, `bun` ≥ 1.2, `cargo`.

```bash
# 1. Build program
cargo-build-sbf                                            # → target/deploy/poker.so

# 2. Install skills (design knowledge) — first time only
bun run skills:install                                     # reads skills-lock.json

# 3. Start a local validator (surfpool has limited RPC; use test-validator for now)
solana-test-validator --reset \
  --bpf-program 9FeibPV2hjbkcu4YHSnUMr9ikWV7QLWMmBpVFZAcYsZH target/deploy/poker.so

# 4. Bootstrap dev USDC mint + table; print env vars
bun run scripts/bootstrap.ts                               # optionally --player=<pubkey> --amount=1000

# 5. Run the stack
bun install
bun --filter @lightly/api dev                              # :4000
bun --filter @lightly/web dev                              # :5173
```

Note: **surfpool 0.1.2 has too narrow an RPC surface for our stack** (no `getAccountInfo`). Upstream is moving fast — check periodically. Until then, `solana-test-validator`.

## Design system — how to make changes look right

The design context is in `.impeccable.md`. Summary:

- **Brand hue**: deep desaturated green (felt). Every neutral tints toward `oklch(x x 150)`.
- **One accent**: warm amber `oklch(0.76 0.12 75)`. Used for to-act halo, wins, brand mark. **Never purple, never cyan, never neon.**
- **Fonts**: Bricolage Grotesque (display), Geist Sans (body), Geist Mono (numbers). **Inter is banned** — see impeccable's `reflex_fonts_to_reject` list.
- **Numbers**: always tabular. Wallet balances, pot, stacks, bets all use `font-feature-settings: "tnum"` via `var(--font-mono)`.
- **Motion**: exponential ease-out `cubic-bezier(0.2, 0.9, 0.2, 1)` (var `--ease`). No bounce. No elastic.
- **Spacing**: 4pt scale with semantic tokens (`--space-1` through `--space-9`). Never magic pixel values.
- **Colors**: OKLCH only. Never `#rrggbb` except in the tiny set of legacy places.
- **Anti-patterns to refuse**: border-left/right > 1px as accent stripe, gradient text (`background-clip: text`), drop shadow with colored glow, glassmorphism everywhere, nested cards.

Invoke `/audit` or `/critique` skills before shipping UI changes; `/polish` for final pass.

## Chain integration (wired April 2026)

- `apps/api/src/chain.ts` — `Chain` class loads operator keypair from `OPERATOR_KEYPAIR_PATH`, connects to `RPC_URL`, submits `begin_hand` and `settle_hand` with priority fees.
- Engine has `onHandBegin` async hook — awaits chain confirm BEFORE dealing. If chain fails, hand aborts, no blinds charged.
- Engine `onHandComplete` submits settle_hand; on success emits real tx sig; on failure emits error (player backstop = `emergency_timeout_refund`).
- Web `apps/web/src/chain.ts` wires `buy_in` + `cash_out` via wallet-adapter. Creates ATA if missing.
- Web `apps/web/src/Wallet.tsx` is the sidebar panel — polls on-chain seat balance + ATA balance every 4s.

**When chain is disabled** (no `RPC_URL`): API falls back to off-chain-only mode with stub tx sigs. Still works for pure game-logic dev.

## Auth

- SIWS (Sign-In With Solana) via `@solana/wallet-adapter-react` + `tweetnacl`. Nonce → sign → sessionId. sessionId is a server-side-held 256-bit bearer token, stored client-side in `sessionStorage`.
- WS reads wallet from the session, not a URL param. Impersonation via `?wallet=X` is blocked.
- Single-socket-per-wallet enforced — prevents one user holding multiple seats via multiple tabs.

## Known gaps / roadmap

See `ROADMAP.md`. High-level priorities:

1. **Session keys + fee-payer relayer** — "sign once, play forever". No more wallet popups per tx.
2. **Embedded wallet** (Privy/Turnkey) + passkey onboarding — new users without existing wallets.
3. **Real VRF** (ORAO) — currently using `crypto.getRandomValues` dev seed.
4. **Squads v4 multisig** for operator authority — currently a single key.
5. **Light Protocol ZK-compressed** action log for full commit-reveal audit trail.
6. **Helius Sender + Jito bundle** for anti-frontrun settlement (current submission is vanilla `sendRawTransaction`).

## How not to break things

- **Never** edit program Rust without running `cargo-build-sbf` and `bun test` before commit. `declare_id!` and keypair `.json` must stay synchronized.
- **Never** add Token-2022 support to `initialize_table` without an extension allowlist. See the tokens comments there.
- **Never** add a new rake-related code path without also adding a rake-cap test in `adversarial.test.ts`.
- **Never** import `node:crypto` or raw `Buffer` from node in `packages/idl` — the web bundle breaks. Use the `buffer` npm package.
- **Never** re-introduce Inter, purple gradients, gradient text, or side-stripe border accents. See `.impeccable.md`.
- Prefer editing existing files. Don't create new docs/readmes unless asked.
- Commit frequently in focused chunks; tag each commit message with what tests ran.

## Commands cheat sheet

```bash
# Build program
cargo-build-sbf

# Run tests
bun test                              # all 58
cd programs/poker/tests && bun test   # 54 program
cd apps/api && bun test               # 4 engine

# Local web dev
bun --filter @lightly/web dev         # http://localhost:5173

# Local api dev
bun --filter @lightly/api dev         # :4000, WS at /ws/:tableId

# Bootstrap local chain state
bun run scripts/bootstrap.ts
bun run scripts/bootstrap.ts --player=<pubkey> --amount=500

# Typecheck
bun run --filter @lightly/web typecheck

# Build web (production)
bun --filter @lightly/web build
```

## Files you'll probably touch first

- `programs/poker/src/lib.rs` — the program
- `apps/api/src/engine.ts` — the Hold'em state machine
- `apps/api/src/index.ts` — HTTP + WS + chain hook wiring
- `apps/web/src/Table.tsx` — the felt + action bar
- `apps/web/src/styles.css` — design tokens
- `.impeccable.md` — design context (read before any UI change)
- `ROADMAP.md` — where this is going

## One-liner summary

Solana-backed Hold'em. Anchor program does escrow + authorized payout with strict conservation. Engine off-chain, fairness via VRF+commit-reveal. UI is a dark private-card-club aesthetic — green, amber, tabular numbers, no neon. Tests are the red team. Read `.impeccable.md` before touching pixels.
