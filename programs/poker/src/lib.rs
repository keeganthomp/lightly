//! Lightly poker — a lean, secure USDC/USDT settlement program.
//!
//! Design:
//!   - All game logic (dealing, hand eval, betting rounds) lives off-chain.
//!   - This program owns ONE concern: custody of the pot and authorized payout.
//!   - The operator (Squads multisig in prod) submits `begin_hand` / `settle_hand`.
//!   - Players unilaterally can always `buy_in`, `cash_out`, and — after the
//!     dispute window — `emergency_timeout_refund`, so operator silence is bounded.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        self, Mint, TokenAccount, TokenInterface, TransferChecked,
    },
};

declare_id!("9FeibPV2hjbkcu4YHSnUMr9ikWV7QLWMmBpVFZAcYsZH");

pub const MAX_SEATS_PER_HAND: usize = 9;
pub const MAX_RAKE_BPS: u16 = 1000; // 10% hard cap
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod poker {
    use super::*;

    /// Create a new table. Operator-signed. Creates the vault ATA owned by the Table PDA.
    pub fn initialize_table(
        ctx: Context<InitializeTable>,
        id: u64,
        min_buy_in: u64,
        max_buy_in: u64,
        small_blind: u64,
        big_blind: u64,
        rake_bps: u16,
        dispute_window_slots: u64,
    ) -> Result<()> {
        require!(min_buy_in > 0, PokerError::InvalidConfig);
        require!(max_buy_in >= min_buy_in, PokerError::InvalidConfig);
        require!(big_blind >= small_blind, PokerError::InvalidConfig);
        require!(big_blind > 0, PokerError::InvalidConfig);
        require!(rake_bps <= MAX_RAKE_BPS, PokerError::RakeTooHigh);
        require!(dispute_window_slots > 0, PokerError::InvalidConfig);

        let table = &mut ctx.accounts.table;
        table.id = id;
        table.operator = ctx.accounts.operator.key();
        table.token_mint = ctx.accounts.token_mint.key();
        table.token_program = ctx.accounts.token_program.key();
        table.min_buy_in = min_buy_in;
        table.max_buy_in = max_buy_in;
        table.small_blind = small_blind;
        table.big_blind = big_blind;
        table.rake_bps = rake_bps;
        table.dispute_window_slots = dispute_window_slots;
        table.rake_accrued = 0;
        table.active_hand_id = 0;
        table.paused = false;
        table.pending_operator = Pubkey::default();
        table.bump = ctx.bumps.table;

        emit!(TableInitialized {
            table: table.key(),
            id,
            operator: table.operator,
            token_mint: table.token_mint,
        });
        Ok(())
    }

    /// Player deposits `amount` of the table's token into the vault.
    pub fn buy_in(ctx: Context<BuyIn>, amount: u64) -> Result<()> {
        let table = &ctx.accounts.table;
        require!(!table.paused, PokerError::TablePaused);
        require!(amount >= table.min_buy_in, PokerError::BuyInTooSmall);
        let seat = &mut ctx.accounts.seat;
        // Refuse top-ups mid-hand — prevents players from changing stack size
        // after actions are locked in off-chain.
        require!(seat.locked_hand_id == 0, PokerError::SeatLocked);
        let new_balance = seat
            .balance
            .checked_add(amount)
            .ok_or(PokerError::Overflow)?;
        require!(new_balance <= table.max_buy_in, PokerError::BuyInTooLarge);

        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.player_ata.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        );
        token_interface::transfer_checked(cpi, amount, ctx.accounts.token_mint.decimals)?;

        seat.player = ctx.accounts.player.key();
        seat.table = ctx.accounts.table.key();
        seat.balance = new_balance;
        seat.locked_hand_id = 0;
        seat.locked_at_slot = 0;
        seat.last_activity_slot = Clock::get()?.slot;
        seat.bump = ctx.bumps.seat;

        emit!(BoughtIn {
            table: seat.table,
            player: seat.player,
            amount,
            new_balance,
        });
        Ok(())
    }

    /// Player withdraws `amount` to their ATA. Fails if seat is locked mid-hand.
    pub fn cash_out(ctx: Context<CashOut>, amount: u64) -> Result<()> {
        let seat = &mut ctx.accounts.seat;
        require!(seat.locked_hand_id == 0, PokerError::SeatLocked);
        require!(amount > 0, PokerError::ZeroAmount);
        require!(amount <= seat.balance, PokerError::InsufficientBalance);

        seat.balance = seat.balance.checked_sub(amount).ok_or(PokerError::Overflow)?;
        seat.last_activity_slot = Clock::get()?.slot;

        let table = &ctx.accounts.table;
        let table_key = table.key();
        let id_bytes = table.id.to_le_bytes();
        let bump = [table.bump];
        let signer_seeds: [&[u8]; 3] = [b"table", id_bytes.as_ref(), bump.as_ref()];
        let signer: &[&[&[u8]]] = &[&signer_seeds];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.player_ata.to_account_info(),
                authority: ctx.accounts.table.to_account_info(),
            },
            signer,
        );
        token_interface::transfer_checked(cpi, amount, ctx.accounts.token_mint.decimals)?;

        emit!(CashedOut {
            table: table_key,
            player: seat.player,
            amount,
            new_balance: seat.balance,
        });
        Ok(())
    }

    /// Operator locks N seats at the start of a hand. Seats stay locked until
    /// `settle_hand` or `emergency_timeout_refund`. `remaining_accounts` is the
    /// list of PlayerSeat PDAs to lock.
    pub fn begin_hand<'info>(
        ctx: Context<'_, '_, 'info, 'info, BeginHand<'info>>,
        hand_id: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.table.paused, PokerError::TablePaused);
        require!(hand_id > 0, PokerError::InvalidHandId);
        require!(
            hand_id > ctx.accounts.table.active_hand_id,
            PokerError::HandIdNotMonotonic
        );
        let table_key = ctx.accounts.table.key();
        let slot = Clock::get()?.slot;
        let seats = &ctx.remaining_accounts;
        require!(!seats.is_empty(), PokerError::NoSeats);
        require!(seats.len() <= MAX_SEATS_PER_HAND, PokerError::TooManySeats);

        for seat_ai in seats.iter() {
            let mut seat: Account<PlayerSeat> = Account::try_from(seat_ai)?;
            require_keys_eq!(seat.table, table_key, PokerError::WrongTable);
            require!(seat.locked_hand_id == 0, PokerError::SeatAlreadyLocked);
            require!(seat.balance > 0, PokerError::EmptySeat);
            seat.locked_hand_id = hand_id;
            seat.locked_at_slot = slot;
            seat.last_activity_slot = slot;
            seat.exit(&crate::ID)?;
        }

        ctx.accounts.table.active_hand_id = hand_id;
        emit!(HandBegun {
            table: table_key,
            hand_id,
            seat_count: seats.len() as u8,
        });
        Ok(())
    }

    /// Operator settles a hand atomically:
    ///   - verifies `sum(debits) == sum(credits) + rake`
    ///   - for each seat: balance = balance - debit + credit
    ///   - unlocks seats (locked_hand_id matching this hand)
    ///   - accrues rake
    ///   - creates SettlementReceipt PDA (replay protection via `init`)
    ///
    /// `remaining_accounts` must be PlayerSeat PDAs in the same order as `deltas`.
    pub fn settle_hand<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleHand<'info>>,
        hand_id: u64,
        deltas: Vec<SeatDelta>,
        rake: u64,
    ) -> Result<()> {
        require!(hand_id > 0, PokerError::InvalidHandId);
        require_eq!(
            deltas.len(),
            ctx.remaining_accounts.len(),
            PokerError::AccountCountMismatch
        );
        require!(deltas.len() <= MAX_SEATS_PER_HAND, PokerError::TooManySeats);

        let mut total_debit: u64 = 0;
        let mut total_credit: u64 = 0;

        let table_key = ctx.accounts.table.key();
        let slot = Clock::get()?.slot;

        for (delta, seat_ai) in deltas.iter().zip(ctx.remaining_accounts.iter()) {
            let mut seat: Account<PlayerSeat> = Account::try_from(seat_ai)?;
            require_keys_eq!(seat.table, table_key, PokerError::WrongTable);
            require_keys_eq!(seat.player, delta.player, PokerError::WrongSeat);
            require!(seat.locked_hand_id == hand_id, PokerError::SeatNotLockedForHand);
            require!(delta.debit <= seat.balance, PokerError::InsufficientBalance);

            seat.balance = seat
                .balance
                .checked_sub(delta.debit)
                .ok_or(PokerError::Overflow)?
                .checked_add(delta.credit)
                .ok_or(PokerError::Overflow)?;
            seat.locked_hand_id = 0;
            seat.locked_at_slot = 0;
            seat.last_activity_slot = slot;
            seat.exit(&crate::ID)?;

            total_debit = total_debit
                .checked_add(delta.debit)
                .ok_or(PokerError::Overflow)?;
            total_credit = total_credit
                .checked_add(delta.credit)
                .ok_or(PokerError::Overflow)?;
        }

        let credit_plus_rake = total_credit.checked_add(rake).ok_or(PokerError::Overflow)?;
        require_eq!(total_debit, credit_plus_rake, PokerError::PotMismatch);

        // Enforce per-hand rake cap. Without this, a malicious operator could set
        // credits = 0 and rake = total_debit, confiscating the entire pot.
        let max_rake = (total_debit as u128)
            .checked_mul(ctx.accounts.table.rake_bps as u128)
            .ok_or(PokerError::Overflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(PokerError::Overflow)? as u64;
        require!(rake <= max_rake, PokerError::RakeExceedsCap);

        let table = &mut ctx.accounts.table;
        table.rake_accrued = table
            .rake_accrued
            .checked_add(rake)
            .ok_or(PokerError::Overflow)?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.table = table_key;
        receipt.hand_id = hand_id;
        receipt.pot_total = total_debit;
        receipt.rake = rake;
        receipt.settled_at_slot = slot;
        receipt.bump = ctx.bumps.receipt;

        emit!(HandSettled {
            table: table_key,
            hand_id,
            pot_total: total_debit,
            rake,
        });
        Ok(())
    }

    /// Player reclaims their full seat balance if operator has left them locked
    /// past the dispute window. This is the trust-minimization backstop.
    pub fn emergency_timeout_refund(ctx: Context<EmergencyTimeoutRefund>) -> Result<()> {
        let seat = &mut ctx.accounts.seat;
        require!(seat.locked_hand_id != 0, PokerError::SeatNotLocked);
        let now = Clock::get()?.slot;
        let deadline = seat
            .locked_at_slot
            .checked_add(ctx.accounts.table.dispute_window_slots)
            .ok_or(PokerError::Overflow)?;
        require!(now >= deadline, PokerError::DisputeWindowActive);

        let amount = seat.balance;
        require!(amount > 0, PokerError::ZeroAmount);
        seat.balance = 0;
        seat.locked_hand_id = 0;
        seat.locked_at_slot = 0;
        seat.last_activity_slot = now;

        let table = &ctx.accounts.table;
        let table_key = table.key();
        let id_bytes = table.id.to_le_bytes();
        let bump = [table.bump];
        let signer_seeds: [&[u8]; 3] = [b"table", id_bytes.as_ref(), bump.as_ref()];
        let signer: &[&[&[u8]]] = &[&signer_seeds];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.player_ata.to_account_info(),
                authority: ctx.accounts.table.to_account_info(),
            },
            signer,
        );
        token_interface::transfer_checked(cpi, amount, ctx.accounts.token_mint.decimals)?;

        emit!(EmergencyRefund {
            table: table_key,
            player: seat.player,
            amount,
        });
        Ok(())
    }

    /// Operator sweeps accrued rake to a treasury ATA.
    pub fn withdraw_rake(ctx: Context<WithdrawRake>, amount: u64) -> Result<()> {
        require!(amount > 0, PokerError::ZeroAmount);
        let table = &mut ctx.accounts.table;
        require!(amount <= table.rake_accrued, PokerError::InsufficientRake);
        table.rake_accrued = table
            .rake_accrued
            .checked_sub(amount)
            .ok_or(PokerError::Overflow)?;

        let table_key = table.key();
        let id_bytes = table.id.to_le_bytes();
        let bump = [table.bump];
        let signer_seeds: [&[u8]; 3] = [b"table", id_bytes.as_ref(), bump.as_ref()];
        let signer: &[&[&[u8]]] = &[&signer_seeds];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.treasury_ata.to_account_info(),
                authority: ctx.accounts.table.to_account_info(),
            },
            signer,
        );
        token_interface::transfer_checked(cpi, amount, ctx.accounts.token_mint.decimals)?;

        emit!(RakeWithdrawn { table: table_key, amount });
        Ok(())
    }

    /// Operator pauses (or unpauses) the table. `begin_hand` and `buy_in` are
    /// blocked while paused. `cash_out`, `settle_hand`, and
    /// `emergency_timeout_refund` remain available so players are never stuck.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.table.paused = paused;
        emit!(PausedChanged { table: ctx.accounts.table.key(), paused });
        Ok(())
    }

    /// Operator nominates a new operator. Rotation requires the nominee to call
    /// `accept_operator` — two-step hand-off prevents fat-finger to a dead key.
    pub fn propose_operator(ctx: Context<ProposeOperator>, new_operator: Pubkey) -> Result<()> {
        ctx.accounts.table.pending_operator = new_operator;
        emit!(OperatorProposed { table: ctx.accounts.table.key(), pending: new_operator });
        Ok(())
    }

    /// Pending operator accepts the handoff. No other account is touched.
    pub fn accept_operator(ctx: Context<AcceptOperator>) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require_keys_eq!(
            ctx.accounts.new_operator.key(),
            table.pending_operator,
            PokerError::NotPendingOperator
        );
        let old = table.operator;
        table.operator = table.pending_operator;
        table.pending_operator = Pubkey::default();
        emit!(OperatorRotated { table: table.key(), old, new: table.operator });
        Ok(())
    }
}

// ---------- Accounts ----------

#[account]
#[derive(InitSpace)]
pub struct Table {
    pub id: u64,
    pub operator: Pubkey,
    pub pending_operator: Pubkey,  // two-step operator rotation; default = Pubkey::default()
    pub token_mint: Pubkey,
    pub token_program: Pubkey,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    pub small_blind: u64,
    pub big_blind: u64,
    pub rake_bps: u16,
    pub dispute_window_slots: u64,
    pub rake_accrued: u64,
    pub active_hand_id: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerSeat {
    pub table: Pubkey,
    pub player: Pubkey,
    pub balance: u64,
    /// 0 means unlocked. Nonzero = the hand_id that locked this seat.
    pub locked_hand_id: u64,
    pub locked_at_slot: u64,
    pub last_activity_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementReceipt {
    pub table: Pubkey,
    pub hand_id: u64,
    pub pot_total: u64,
    pub rake: u64,
    pub settled_at_slot: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SeatDelta {
    pub player: Pubkey,
    /// Amount removed from seat (what the player put into the pot this hand).
    pub debit: u64,
    /// Amount added to seat (what the player collects from the pot this hand).
    pub credit: u64,
}

// ---------- Context structs ----------

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct InitializeTable<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        init,
        payer = operator,
        space = 8 + Table::INIT_SPACE,
        seeds = [b"table".as_ref(), id.to_le_bytes().as_ref()],
        bump,
    )]
    pub table: Account<'info, Table>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = operator,
        associated_token::mint = token_mint,
        associated_token::authority = table,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    // MVP: restrict to classic SPL Token. Token-2022 support requires an
    // extension allowlist (reject PermanentDelegate, TransferFee,
    // DefaultAccountState=Frozen, TransferHook, ConfidentialTransfer,
    // MintCloseAuthority, NonTransferable) — shipping after audit.
    #[account(
        constraint = token_program.key() == anchor_spl::token::ID @ PokerError::UnsupportedTokenProgram,
    )]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyIn<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = token_mint,
        has_one = token_program,
    )]
    pub table: Account<'info, Table>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = player,
        associated_token::token_program = token_program,
    )]
    pub player_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = table,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerSeat::INIT_SPACE,
        seeds = [b"seat".as_ref(), table.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub seat: Account<'info, PlayerSeat>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    pub player: Signer<'info>,

    #[account(
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = token_mint,
        has_one = token_program,
    )]
    pub table: Account<'info, Table>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = player,
        associated_token::token_program = token_program,
    )]
    pub player_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = table,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"seat".as_ref(), table.key().as_ref(), player.key().as_ref()],
        bump = seat.bump,
        has_one = player,
    )]
    pub seat: Account<'info, PlayerSeat>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BeginHand<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = operator,
    )]
    pub table: Account<'info, Table>,
}

#[derive(Accounts)]
#[instruction(hand_id: u64)]
pub struct SettleHand<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = operator,
    )]
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = operator,
        space = 8 + SettlementReceipt::INIT_SPACE,
        seeds = [b"receipt".as_ref(), table.key().as_ref(), hand_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub receipt: Account<'info, SettlementReceipt>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencyTimeoutRefund<'info> {
    pub player: Signer<'info>,

    #[account(
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = token_mint,
        has_one = token_program,
    )]
    pub table: Account<'info, Table>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = player,
        associated_token::token_program = token_program,
    )]
    pub player_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = table,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"seat".as_ref(), table.key().as_ref(), player.key().as_ref()],
        bump = seat.bump,
        has_one = player,
    )]
    pub seat: Account<'info, PlayerSeat>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawRake<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = operator,
        has_one = token_mint,
        has_one = token_program,
    )]
    pub table: Account<'info, Table>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = table,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = token_mint,
        token::token_program = token_program,
    )]
    pub treasury_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = operator,
    )]
    pub table: Account<'info, Table>,
}

#[derive(Accounts)]
pub struct ProposeOperator<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
        has_one = operator,
    )]
    pub table: Account<'info, Table>,
}

#[derive(Accounts)]
pub struct AcceptOperator<'info> {
    pub new_operator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"table".as_ref(), table.id.to_le_bytes().as_ref()],
        bump = table.bump,
    )]
    pub table: Account<'info, Table>,
}

// ---------- Events ----------

#[event]
pub struct TableInitialized {
    pub table: Pubkey,
    pub id: u64,
    pub operator: Pubkey,
    pub token_mint: Pubkey,
}

#[event]
pub struct BoughtIn {
    pub table: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct CashedOut {
    pub table: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
}

#[event]
pub struct HandBegun {
    pub table: Pubkey,
    pub hand_id: u64,
    pub seat_count: u8,
}

#[event]
pub struct HandSettled {
    pub table: Pubkey,
    pub hand_id: u64,
    pub pot_total: u64,
    pub rake: u64,
}

#[event]
pub struct EmergencyRefund {
    pub table: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RakeWithdrawn {
    pub table: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PausedChanged {
    pub table: Pubkey,
    pub paused: bool,
}

#[event]
pub struct OperatorProposed {
    pub table: Pubkey,
    pub pending: Pubkey,
}

#[event]
pub struct OperatorRotated {
    pub table: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
}

// ---------- Errors ----------

#[error_code]
pub enum PokerError {
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("invalid config parameter")]
    InvalidConfig,
    #[msg("rake exceeds max allowed (1000 bps)")]
    RakeTooHigh,
    #[msg("buy-in below table minimum")]
    BuyInTooSmall,
    #[msg("buy-in would exceed table maximum")]
    BuyInTooLarge,
    #[msg("amount must be > 0")]
    ZeroAmount,
    #[msg("seat has insufficient balance")]
    InsufficientBalance,
    #[msg("seat is locked in an active hand")]
    SeatLocked,
    #[msg("seat is not locked")]
    SeatNotLocked,
    #[msg("seat already locked in another hand")]
    SeatAlreadyLocked,
    #[msg("seat not locked for this hand id")]
    SeatNotLockedForHand,
    #[msg("seat belongs to a different table")]
    WrongTable,
    #[msg("delta player does not match seat player")]
    WrongSeat,
    #[msg("seat has zero balance")]
    EmptySeat,
    #[msg("pot debits do not equal credits + rake")]
    PotMismatch,
    #[msg("passed account count does not match deltas")]
    AccountCountMismatch,
    #[msg("hand_id must be > 0")]
    InvalidHandId,
    #[msg("hand_id must be strictly greater than last active hand_id")]
    HandIdNotMonotonic,
    #[msg("no seats provided")]
    NoSeats,
    #[msg("too many seats (max 9)")]
    TooManySeats,
    #[msg("dispute window has not elapsed")]
    DisputeWindowActive,
    #[msg("rake accrued is less than requested amount")]
    InsufficientRake,
    #[msg("rake exceeds per-hand cap (rake_bps of pot)")]
    RakeExceedsCap,
    #[msg("table is paused")]
    TablePaused,
    #[msg("not the pending operator")]
    NotPendingOperator,
    #[msg("token program is not allowed (MVP: classic SPL only)")]
    UnsupportedTokenProgram,
}
