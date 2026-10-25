use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    place::{CanvasChunk, Config, Player, CHUNK_SIZE},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;
const W: u16 = 200;
const H: u16 = 150; // 30_000 px -> 3 chunks
const BASE: u64 = 100_000;
const INC: u64 = 50_000;
const COOLDOWN: i64 = 30;

struct Env {
    svm: LiteSVM,
    authority: Keypair,
}

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &place::id()).0
}

fn chunk_pda(i: u16) -> Pubkey {
    Pubkey::find_program_address(&[b"chunk", &i.to_le_bytes()], &place::id()).0
}

fn player_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"player", wallet.as_ref()], &place::id()).0
}

fn chunk_of(x: u16, y: u16) -> u16 {
    ((y as u32 * W as u32 + x as u32) / CHUNK_SIZE as u32) as u16
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/place.so"));
        svm.add_program(place::id(), bytes).unwrap();
        let authority = Keypair::new();
        svm.airdrop(&authority.pubkey(), 100 * SOL).unwrap();
        let mut env = Env { svm, authority };

        let ix = Instruction::new_with_bytes(
            place::id(),
            &place::instruction::Initialize {
                width: W,
                height: H,
                base_price: BASE,
                price_increment: INC,
                cooldown_secs: COOLDOWN,
            }
            .data(),
            place::accounts::Initialize {
                config: config_pda(),
                authority: env.authority.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let auth = env.authority.insecure_clone();
        env.send(ix, &auth).unwrap();
        for i in 0..3u16 {
            env.send(env.init_chunk_ix(i, &auth.pubkey()), &auth).unwrap();
        }
        env
    }

    fn init_chunk_ix(&self, index: u16, authority: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            place::id(),
            &place::instruction::InitChunk { index }.data(),
            place::accounts::InitChunk {
                config: config_pda(),
                chunk: chunk_pda(index),
                authority: *authority,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Sends one instruction; on failure returns the program logs joined into one string.
    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| e.meta.logs.join("\n"))
    }

    fn funded(&mut self) -> Keypair {
        let p = Keypair::new();
        self.svm.airdrop(&p.pubkey(), 10 * SOL).unwrap();
        p
    }

    fn place_ix_with_chunk(&self, painter: &Pubkey, chunk: u16, x: u16, y: u16, color: u8) -> Instruction {
        Instruction::new_with_bytes(
            place::id(),
            &place::instruction::PlacePixel { chunk_index: chunk, x, y, color }.data(),
            place::accounts::PlacePixel {
                config: config_pda(),
                chunk: chunk_pda(chunk),
                player: player_pda(painter),
                painter: *painter,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn place(&mut self, painter: &Keypair, x: u16, y: u16, color: u8) -> Result<(), String> {
        let ix = self.place_ix_with_chunk(&painter.pubkey(), chunk_of(x, y), x, y, color);
        self.send(ix, painter)
    }

    fn warp(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    fn pixel(&self, x: u16, y: u16) -> u8 {
        let i = y as usize * W as usize + x as usize;
        let acc = self.svm.get_account(&chunk_pda((i / CHUNK_SIZE) as u16)).unwrap();
        // zero_copy layout: 8-byte discriminator, then the raw pixel bytes.
        assert_eq!(acc.data.len(), 8 + std::mem::size_of::<CanvasChunk>());
        acc.data[8 + i % CHUNK_SIZE]
    }

    fn config(&self) -> Config {
        let acc = self.svm.get_account(&config_pda()).unwrap();
        Config::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn player_state(&self, wallet: &Pubkey) -> Player {
        let acc = self.svm.get_account(&player_pda(wallet)).unwrap();
        Player::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }
}

#[test]
fn places_a_pixel_and_charges_base_price() {
    let mut env = Env::new();
    let alice = env.funded();
    let vault_before = env.lamports(&config_pda());

    env.place(&alice, 10, 20, 5).unwrap();

    assert_eq!(env.pixel(10, 20), (1 << 4) | 5, "color 5, tier 1");
    assert_eq!(env.lamports(&config_pda()) - vault_before, BASE);
    let cfg = env.config();
    assert_eq!(cfg.total_placements, 1);
    assert_eq!(cfg.total_collected, BASE);
    let p = env.player_state(&alice.pubkey());
    assert_eq!(p.wallet, alice.pubkey());
    assert_eq!(p.pixels_placed, 1);
    assert_eq!(p.lamports_spent, BASE);
}

#[test]
fn pixels_in_every_chunk_work() {
    let mut env = Env::new();
    // Last pixel of chunk 0, first of chunk 1, and the very last pixel of the canvas.
    let cases = [(199u16, 49u16), (0, 50), (W - 1, H - 1)];
    for (n, (x, y)) in cases.into_iter().enumerate() {
        let p = env.funded();
        env.place(&p, x, y, (n + 1) as u8).unwrap();
        assert_eq!(env.pixel(x, y) & 0xf, (n + 1) as u8);
    }
}

#[test]
fn cooldown_blocks_until_it_expires() {
    let mut env = Env::new();
    let alice = env.funded();
    env.place(&alice, 1, 1, 3).unwrap();

    let err = env.place(&alice, 2, 2, 3).unwrap_err();
    assert!(err.contains("CooldownActive"), "{err}");

    env.warp(COOLDOWN - 1);
    assert!(env.place(&alice, 2, 2, 3).unwrap_err().contains("CooldownActive"));

    env.warp(1);
    env.place(&alice, 2, 2, 3).unwrap();
    assert_eq!(env.player_state(&alice.pubkey()).pixels_placed, 2);
}

#[test]
fn cooldown_is_per_wallet() {
    let mut env = Env::new();
    let (alice, bob) = (env.funded(), env.funded());
    env.place(&alice, 1, 1, 3).unwrap();
    env.place(&bob, 1, 1, 4).unwrap();
    assert_eq!(env.pixel(1, 1), (2 << 4) | 4);
}

#[test]
fn price_rises_per_overwrite_and_saturates_at_tier_15() {
    let mut env = Env::new();
    let painter = env.funded();
    for n in 0..18u64 {
        let before = env.lamports(&config_pda());
        env.place(&painter, 7, 7, (n % 16) as u8).unwrap();
        let tier = n.min(15);
        assert_eq!(env.lamports(&config_pda()) - before, BASE + INC * tier, "placement {n}");
        env.warp(COOLDOWN);
    }
    assert_eq!(env.pixel(7, 7) >> 4, 15);
    let expected: u64 = (0..18u64).map(|n| BASE + INC * n.min(15)).sum();
    assert_eq!(env.player_state(&painter.pubkey()).lamports_spent, expected);
}

#[test]
fn rejects_out_of_bounds_and_bad_color() {
    let mut env = Env::new();
    let p = env.funded();
    let ix = env.place_ix_with_chunk(&p.pubkey(), 0, W, 0, 1);
    assert!(env.send(ix, &p).unwrap_err().contains("OutOfBounds"));
    let ix = env.place_ix_with_chunk(&p.pubkey(), 0, 0, H, 1);
    assert!(env.send(ix, &p).unwrap_err().contains("OutOfBounds"));
    assert!(env.place(&p, 0, 0, 16).unwrap_err().contains("InvalidColor"));
}

#[test]
fn rejects_wrong_chunk_account() {
    let mut env = Env::new();
    let p = env.funded();
    // (0, 0) lives in chunk 0; passing chunk 1 must fail.
    let ix = env.place_ix_with_chunk(&p.pubkey(), 1, 0, 0, 1);
    assert!(env.send(ix, &p).unwrap_err().contains("WrongChunk"));
}

#[test]
fn only_authority_can_init_chunks_and_extra_chunks_are_rejected() {
    let mut env = Env::new();
    let mallory = env.funded();
    let ix = env.init_chunk_ix(3, &mallory.pubkey());
    assert!(env.send(ix, &mallory).unwrap_err().contains("Unauthorized"));
    // Chunk 3 is past the end of a 3-chunk canvas.
    let auth = env.authority.insecure_clone();
    let ix = env.init_chunk_ix(3, &auth.pubkey());
    assert!(env.send(ix, &auth).unwrap_err().contains("WrongChunk"));
    // Existing chunks can't be re-initialized (and wiped).
    let ix = env.init_chunk_ix(0, &auth.pubkey());
    assert!(env.send(ix, &auth).is_err());
}

fn withdraw_ix(authority: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        place::id(),
        &place::instruction::Withdraw { amount }.data(),
        place::accounts::Withdraw { config: config_pda(), authority: *authority, to: *to }.to_account_metas(None),
    )
}

#[test]
fn withdraw_respects_rent_and_authority() {
    let mut env = Env::new();
    for _ in 0..3 {
        let p = env.funded();
        env.place(&p, 0, 0, 1).unwrap();
    }
    let collected = BASE + (BASE + INC) + (BASE + 2 * INC);
    let auth = env.authority.insecure_clone();
    let dest = Keypair::new().pubkey();

    let mallory = env.funded();
    let ix = withdraw_ix(&mallory.pubkey(), &mallory.pubkey(), 1);
    assert!(env.send(ix, &mallory).unwrap_err().contains("Unauthorized"));

    // One lamport more than the fees would dip into the rent reserve.
    let ix = withdraw_ix(&auth.pubkey(), &dest, collected + 1);
    assert!(env.send(ix, &auth).unwrap_err().contains("InsufficientVault"));

    let ix = withdraw_ix(&auth.pubkey(), &dest, collected);
    env.send(ix, &auth).unwrap();
    assert_eq!(env.lamports(&dest), collected);
}

#[test]
fn set_authority_hands_over_control() {
    let mut env = Env::new();
    let auth = env.authority.insecure_clone();
    let next = env.funded();
    let ix = Instruction::new_with_bytes(
        place::id(),
        &place::instruction::SetAuthority { new_authority: next.pubkey() }.data(),
        place::accounts::AuthorityOnly { config: config_pda(), authority: auth.pubkey() }.to_account_metas(None),
    );
    env.send(ix, &auth).unwrap();
    assert_eq!(env.config().authority, next.pubkey());
    let ix = withdraw_ix(&auth.pubkey(), &auth.pubkey(), 0);
    assert!(env.send(ix, &auth).unwrap_err().contains("Unauthorized"));
}
