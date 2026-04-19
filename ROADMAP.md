# Lightly Roadmap

> Goal: a player should feel like they're playing a polished web poker app. No wallet popups per hand. No "pending transactions". No jargon. Chain is an implementation detail.

The MVP handles the money plumbing correctly. The post-MVP work is entirely about **hiding the chain** and **reducing friction**.

---

## Guiding principles

1. **Sign once, play forever.** At most one wallet popup per session (SIWS). Anything after that runs under a scoped session key the server or a delegate key can spend on the player's behalf, within tight limits.
2. **Fiat-native UX.** Chips denominated in USD, not sats or lamports. SOL for fees is never shown — it's abstracted behind a relayer or fee-payer.
3. **Optimistic UI, chain-backed truth.** Every action updates the UI immediately; reconciliation with the chain happens in the background. Failures are handled by showing a reconnect modal, not by stopping the hand.
4. **Fail toward refund.** Any ambiguity defaults to returning funds. Players should never feel stuck.

---

## Phase 1 — Hide the wallet popups (weeks 1–3)

### 1.1 Session keys / ephemeral signers

**Problem:** today a player signs once for SIWS but every action is an off-chain WS message signed by trust alone; when we wire real on-chain settlement, we'd have to pop Phantom for each `begin_hand`/`settle_hand` if we use the player's key.

**Solution:** session keys. At sign-in time the player authorizes a fresh session keypair to act as a limited delegate for ~24h. The session key is held server-side (encrypted) or in the browser's non-extractable WebCrypto store.

**Design:**
- New on-chain `SessionKey` PDA: `seeds = ["session", player, table]`. Fields: `pubkey`, `expires_at_slot`, `spend_limit`, `nonce`.
- Player signs a single `authorize_session(session_pubkey, expiry, limit)` tx. After that the server (or the session key itself, in a "delegation" model) can co-sign player-initiated actions up to `limit` USDC cumulatively.
- Server-side session keys give best UX but concentrate custody; prefer browser-held session keys with a server-side relayer that broadcasts pre-signed txs.
- Inspired by Honeycomb / Dialect session-keys and the EIP-7702-style session abstractions being tested on Solana in early 2026.

**UX win:** player never sees another Phantom popup until the session expires.

### 1.2 Gasless transactions (fee-payer relayer)

**Problem:** every tx needs SOL for fees. We can't ship a UX where "you need SOL" is a step.

**Solution:** a fee-payer relayer.
- Operator hot wallet (Squads-managed, capped) pays SOL fees on behalf of players.
- Client constructs tx, signs with session key, POSTs to `POST /relay` on our API. Relayer adds itself as fee payer, co-signs, and broadcasts via Helius Sender.
- Rate-limit per session (e.g. 200 relayed txs/hour) and per-action (only allow-listed instruction types).
- Bonus: the same relayer handles cash-out → the player sees "Cashing out… ✓" with no wallet popup.

**What to build:**
- `apps/relayer/` — small Hono service with an allow-list of `(programId, ixDiscriminator)` pairs. Rejects anything else. Signs as fee payer only, never as a player authority.
- `POST /relay` endpoint: validates the session, validates the ix, broadcasts via Helius Sender with priority fee auto-attached.
- Observability: record relayed txs in Drizzle for cost attribution.

### 1.3 Silent deposits (embedded wallet or buy-with-card)

**Problem:** even the deposit step is painful — swap to USDC, pay SOL fees, approve ATA, approve transfer. That's 2+ popups.

**Options:**
- **Privy / Turnkey / Dynamic embedded wallets.** Players sign in with email/Google/passkey; the wallet is created server-side under MPC. No Phantom. Players can still bridge in/out, but the default flow is seamless.
- **Coinbase / MoonPay / Stripe on-ramp.** USDC delivered directly to the embedded wallet from fiat. One-tap.
- **Apple Pay → USDC via Stripe Crypto (Feb 2026 GA).** For iOS players this is effectively invisible.
- **Privy v3 (Q1 2026) has session signers + gasless out of the box** — evaluate as the fastest path.

**Decision gate:** do we own custody of player funds (fastest, regulatory risk) or use an embedded wallet provider (slower to integrate, cleaner compliance)? Spec this with counsel before building.

### 1.4 Progressive auth (passkey → wallet)

**Goal:** new users can start playing in under 30 seconds.

**Flow:**
1. Email + passkey signup → embedded wallet minted (Privy/Turnkey).
2. Player gets 10 free USDC via promo table (play-money, no real stake).
3. Once they want real stakes, they can either:
   - Fund the embedded wallet via card/Apple Pay (stays custodial).
   - Export/link a Phantom wallet (graduates to self-custody).

Dashboard surfaces "upgrade to self-custody" only when the balance warrants it.

---

## Phase 2 — Hide the blockchain (weeks 3–6)

### 2.1 Auto-buy-in / auto-seat

**Today:** player clicks seat → we open a "buy in" modal → they sign a `buy_in` tx → wait for confirmation → then they're seated.

**Target:** player clicks seat → they're seated.

**How:** relayer pre-signs the `buy_in` tx on the player's behalf using their session key, bundled with the seat assignment. Player sees "Seated. Stack: $50." The tx is confirming in the background. If it fails, we roll back the local seat and show an inline error.

### 2.2 Optimistic in-hand state

The engine already runs on WebSockets, which is optimistic by default. But we need:
- Instant action feedback even when the server is 100ms away (client-side prediction with server reconciliation).
- Graceful degradation: if the WS drops mid-hand, reconnect and replay events from the last seq number; never show a blank table.
- A "reconciling…" badge (never modal) when we're behind, with auto-clear.

### 2.3 Invisible settlement

**Today:** at showdown we emit `settled` with a stub tx sig.

**Target:** settlement tx is submitted via the relayer + Helius Sender the instant the hand ends, priority fee auto-tuned, Jito-bundled for frontrun protection. Player sees the USDC balance update animate in < 1s. The tx sig is logged but never shown unless the player digs into an "activity" drawer.

**Failure handling:**
- If settlement tx fails (network halt, priority fee spike), the engine queues it and retries. Players' on-screen stacks reflect the engine's truth; chain reconciles when it comes back.
- If the operator can't land the settle within `dispute_window`, players' unilateral `emergency_timeout_refund` kicks in — the UI presents this as a "take back your chips" button, not as a protocol backstop.

### 2.4 Settlement batching

For high-volume tournaments, submit `settle_hand` once per N hands instead of per hand. Requires extending the program to accept a batched settlement ix (Merkle root of hand outcomes + per-player aggregate deltas). Alternatively: use **MagicBlock ephemeral rollups** — delegate the Table PDA to a rollup, play at 20ms, commit back to mainnet on session close. Right answer for tournament volume.

### 2.5 USD-denominated chips everywhere

The chain stores micro-USDC. The UI should always show dollars. Rounding:
- Chip display: `$12.30` (2 decimals).
- Hover tooltip: `12,300,000 micro-USDC`.
- Rake explanation in onboarding: "2.5% of each pot".

### 2.6 Replace jargon

| Bad | Good |
|---|---|
| Wallet | Your account |
| Signature / sign | Confirm |
| Transaction | Action / settlement |
| RPC error | "Reconnecting… ↻" |
| Program ID | (hidden) |
| Tx confirmed | "Saved" |

---

## Phase 3 — Fair-by-design card dealing (weeks 4–8)

Currently: dev RNG seed + sha256 commit-reveal. Fine for a beta, insufficient for real money.

### 3.1 On-chain VRF

Integrate **ORAO VRF**. Each hand costs ~0.001 SOL; relayer covers it. VRF proof is stored in the hand record so anyone can verify the deck was derived from a seed the server couldn't grind.

### 3.2 Commit chain of actions

Beyond the deck, the sequence of actions is the other place a malicious operator could cheat. Commit each action's hash to a **Light Protocol ZK-compressed** account: `(hand_id, seq, action_hash)`. At showdown reveal the full action log; anyone can audit.

### 3.3 Mental-poker upgrade (v3)

Once the SNARK-based mental-poker libraries mature (the 2025 research lines show ~50ms shuffle proofs), add a "trustless tables" tier. Slower but zero operator trust.

---

## Phase 4 — Operations & trust (ongoing)

### 4.1 Squads multisig operator

Move the operator key to a **Squads v4 3-of-5 multisig** with:
- 1 HSM-held key (signs automated settlements).
- 2 Turnkey-backed team keys.
- 2 cold keys offline.
- Time-lock on `set_paused(false)` and `propose_operator` (e.g. 24h).

### 4.2 Observability

- Grafana dashboard tracking the conservation invariant: `vault_balance == sum(seat.balance) + rake_accrued` per table, continuously. Alert on drift > 0.
- Helius LaserStream gRPC feed → Postgres settlements table. Catch dropped settlements and retry.
- Public audit log: commit each hand's `(handId, commitHash, vrfProof, settlementTxSig)` to a cheap storage (R2/S3); readable from the "Fairness" sidebar.

### 4.3 Anti-collusion

- Shared-IP and shared-device flagging.
- Chip-dumping pattern detection: two players consistently showing down weak hands to transfer chips.
- Action-timing fingerprinting: bots often have suspiciously regular action latency distributions.
- Use the off-chain `actions` table (Drizzle) as the data source; run an offline ML pipeline nightly.

### 4.4 Bug bounty + audit

- External audit by OtterSec / Neodyme / Zellic before mainnet.
- Immunefi bug bounty with tiered payouts (critical up to $100k once TVL justifies).

---

## Phase 5 — Growth UX (when the core is solid)

- **Leaderboards.** On-chain claim tx for season rewards (auto-claimed via relayer).
- **Tournaments.** Scheduled MTT with guaranteed prize pools; escrowed via program.
- **Friends / clubs.** Private tables via invite link.
- **Mobile app.** React Native with Mobile Wallet Adapter; same session-key model.
- **Achievements / cNFTs.** Occasional drops (first royal flush, etc.) minted via ZK compression → near-zero cost.

---

## Explicit non-goals for the MVP

We can say no to these for now:
- Multiple currencies (USDC only first).
- Cross-chain bridges.
- Tournaments / sit-n-go.
- Customizable avatars / chat / emotes.
- Rebuy / add-on economics.
- Automatic rake-to-reward token.

---

## Metrics to watch

| Metric | Target |
|---|---|
| Time from "connect wallet" to first hand | < 60s |
| Wallet popups per hour of play | 0 (post-sign-in) |
| Median settlement confirmation | < 2s |
| Conservation invariant drift | 0, always |
| Relayer cost per hand | < $0.005 |
| % of hands with on-chain commit+reveal | 100% |
| P99 action latency | < 200ms client→server→client |

---

## Ordering & gating

Ship order:
1. Phase 1.1 session keys + 1.2 relayer (unlocks "sign once").
2. Phase 4.1 Squads multisig + 4.2 observability (required before real money).
3. Phase 3.1 on-chain VRF (required for "provably fair" marketing).
4. Phase 1.3 embedded wallet + 1.4 passkey (unlocks mainstream funnel).
5. Phase 2 UX polish (invisible settlement, optimistic UI).
6. Phase 3.2–3.3 deeper fairness.
7. Phase 5 growth features.

Each phase should have its own audit and property-test pass before the next begins. Conservation invariant tests (the `ledger + rake = vault` math) run in CI on every PR; if they fail, merge is blocked.
