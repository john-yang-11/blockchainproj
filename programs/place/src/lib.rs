//! OnChain Place: r/place as a Solana program.
//!
//! The whole canvas lives on-chain in program-owned "chunk" accounts. Each pixel is one byte:
//! the low 4 bits are the color (r/place 2017 palette index), the high 4 bits are an overwrite
//! tier (0-15, saturating) that drives the price. The canvas is split linearly into chunks of
//! `CHUNK_SIZE` bytes so every chunk can be created by the program itself (under the 10 KiB CPI
//! allocation limit) and a client can load the full board with one `getMultipleAccounts` call.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("6Pghm9oUF9Tx6VXUwGed7iKqL1qqnYvXciCUaCT63S3L");

/// Pixels (bytes) per chunk account. 8-byte discriminator + 10_000 stays under 10_240.
pub const CHUNK_SIZE: usize = 10_000;
pub const COLORS: u8 = 16;
pub const MAX_TIER: u8 = 15;
pub const MAX_SIDE: u16 = 4096;

#[program]
pub mod place {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        width: u16,
        height: u16,
        base_price: u64,
        price_increment: u64,
        cooldown_secs: i64,
    ) -> Result<()> {
        require!(
            width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE,
            PlaceError::BadConfig
        );
        require!(cooldown_secs >= 0, PlaceError::BadConfig);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.width = width;
        config.height = height;
        config.base_price = base_price;
        config.price_increment = price_increment;
        config.cooldown_secs = cooldown_secs;
        config.total_placements = 0;
        config.total_collected = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Creates one zero-filled (all white, tier 0) canvas chunk. Called once per chunk at deploy.
    pub fn init_chunk(ctx: Context<InitChunk>, index: u16) -> Result<()> {
        require!((index as u32) < ctx.accounts.config.chunk_count(), PlaceError::WrongChunk);
        ctx.accounts.chunk.load_init()?;
        Ok(())
    }

    pub fn place_pixel(ctx: Context<PlacePixel>, chunk_index: u16, x: u16, y: u16, color: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(x < config.width && y < config.height, PlaceError::OutOfBounds);
        require!(color < COLORS, PlaceError::InvalidColor);

        let pixel = config.pixel_index(x, y);
        require!(pixel / CHUNK_SIZE as u32 == chunk_index as u32, PlaceError::WrongChunk);
        let offset = (pixel % CHUNK_SIZE as u32) as usize;

        let now = Clock::get()?.unix_timestamp;
        let player = &mut ctx.accounts.player;
        if player.pixels_placed > 0 {
            let ready_at = player.last_placed.saturating_add(config.cooldown_secs);
            require!(now >= ready_at, PlaceError::CooldownActive);
        }

        let mut chunk = ctx.accounts.chunk.load_mut()?;
        let old = chunk.pixels[offset];
        let tier = old >> 4;
        let price = config.price_for_tier(tier);

        if price > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.painter.to_account_info(),
                        to: ctx.accounts.config.to_account_info(),
                    },
                ),
                price,
            )?;
        }

        chunk.pixels[offset] = (tier.saturating_add(1).min(MAX_TIER) << 4) | color;
        drop(chunk);

        let painter = ctx.accounts.painter.key();
        if player.pixels_placed == 0 {
            player.wallet = painter;
            player.bump = ctx.bumps.player;
        }
        player.last_placed = now;
        player.pixels_placed += 1;
        player.lamports_spent = player.lamports_spent.saturating_add(price);

        let config = &mut ctx.accounts.config;
        config.total_placements += 1;
        config.total_collected = config.total_collected.saturating_add(price);

        emit!(PixelPlaced {
            x,
            y,
            color,
            tier_before: tier,
            painter,
            price,
            timestamp: now,
        });
        Ok(())
    }

    /// Moves collected fees to `to`, never dropping the config below rent exemption.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let config_info = ctx.accounts.config.to_account_info();
        let min = Rent::get()?.minimum_balance(config_info.data_len());
        let available = config_info.lamports().saturating_sub(min);
        require!(amount <= available, PlaceError::InsufficientVault);

        **config_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.to.to_account_info().try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    pub fn set_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    /// Local demo only: bulk-writes raw pixel bytes so the board isn't empty. Compiled out of
    /// every build except `--features localnet`, so it never exists on devnet.
    #[cfg(feature = "localnet")]
    pub fn seed_pixels(ctx: Context<SeedPixels>, _chunk_index: u16, offset: u32, data: Vec<u8>) -> Result<()> {
        let mut chunk = ctx.accounts.chunk.load_mut()?;
        let start = offset as usize;
        let end = start.checked_add(data.len()).ok_or(PlaceError::OutOfBounds)?;
        require!(end <= CHUNK_SIZE, PlaceError::OutOfBounds);
        chunk.pixels[start..end].copy_from_slice(&data);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub width: u16,
    pub height: u16,
    pub base_price: u64,
    pub price_increment: u64,
    pub cooldown_secs: i64,
    pub total_placements: u64,
    pub total_collected: u64,
    pub bump: u8,
}

impl Config {
    pub fn pixel_index(&self, x: u16, y: u16) -> u32 {
        y as u32 * self.width as u32 + x as u32
    }

    pub fn chunk_count(&self) -> u32 {
        (self.width as u32 * self.height as u32).div_ceil(CHUNK_SIZE as u32)
    }

    pub fn price_for_tier(&self, tier: u8) -> u64 {
        self.base_price
            .saturating_add(self.price_increment.saturating_mul(tier as u64))
    }
}

#[account(zero_copy)]
pub struct CanvasChunk {
    pub pixels: [u8; CHUNK_SIZE],
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub wallet: Pubkey,
    pub last_placed: i64,
    pub pixels_placed: u64,
    pub lamports_spent: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u16)]
pub struct InitChunk<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ PlaceError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + CHUNK_SIZE,
        seeds = [b"chunk", index.to_le_bytes().as_ref()],
        bump
    )]
    pub chunk: AccountLoader<'info, CanvasChunk>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(chunk_index: u16)]
pub struct PlacePixel<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"chunk", chunk_index.to_le_bytes().as_ref()], bump)]
    pub chunk: AccountLoader<'info, CanvasChunk>,
    #[account(
        init_if_needed,
        payer = painter,
        space = 8 + Player::INIT_SPACE,
        seeds = [b"player", painter.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub painter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ PlaceError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    /// CHECK: any account the authority chooses to receive the fees.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ PlaceError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[cfg(feature = "localnet")]
#[derive(Accounts)]
#[instruction(chunk_index: u16)]
pub struct SeedPixels<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ PlaceError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"chunk", chunk_index.to_le_bytes().as_ref()], bump)]
    pub chunk: AccountLoader<'info, CanvasChunk>,
    pub authority: Signer<'info>,
}

#[event]
pub struct PixelPlaced {
    pub x: u16,
    pub y: u16,
    pub color: u8,
    pub tier_before: u8,
    pub painter: Pubkey,
    pub price: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum PlaceError {
    #[msg("Pixel is outside the canvas")]
    OutOfBounds,
    #[msg("Color must be a palette index from 0 to 15")]
    InvalidColor,
    #[msg("Cooldown active: wait before placing another pixel")]
    CooldownActive,
    #[msg("Chunk account does not match the pixel coordinates")]
    WrongChunk,
    #[msg("Not enough withdrawable lamports in the vault")]
    InsufficientVault,
    #[msg("Only the authority can do this")]
    Unauthorized,
    #[msg("Invalid canvas configuration")]
    BadConfig,
}
