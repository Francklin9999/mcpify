/*!
MCP Forge — On-chain Server Registry
=====================================
Fixed-size account layout, no external dependencies beyond `solana-program`.

Account layout (RECORD_SIZE = 451 bytes):
  [0]       discriminant  u8      magic = 0xAB
  [1..33]   authority     [u8;32] registrant public key
  [33..69]  server_id     [u8;36] UUID string (ASCII)
  [69..269] url           [u8;200] UTF-8 (zero-padded)
  [269]     url_len       u8
  [270..370] title        [u8;100] UTF-8 (zero-padded)
  [370]     title_len     u8
  [371..435] tool_sig     [u8;64] sha256 hex of sorted tool names
  [435]     confidence    u8      0-100
  [436..438] tool_count   u16     little-endian
  [438..442] version      u32     little-endian
  [442..450] updated_at   i64     unix seconds, little-endian
  [450]     bump          u8      PDA bump seed

Instruction data: [discriminant u8, ...args]
  0x00 = register_server
  0x01 = update_server
*/

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

solana_program::declare_id!("B6xe3XtwyokW7Nsud63otwagnJS4GMkAutWXwftMtCKh");

pub const RECORD_SIZE: usize = 451;
const DISCRIMINANT: u8 = 0xAB;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    match data[0] {
        0x00 => ix_register(program_id, accounts, &data[1..]),
        0x01 => ix_update(program_id, accounts, &data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ── register_server ───────────────────────────────────────────────────────────
//
// Args layout (after discriminant byte):
//   [0..36]   server_id  [u8;36]
//   [36..236] url        [u8;200]
//   [236]     url_len    u8
//   [237..337] title     [u8;100]
//   [337]     title_len  u8
//   [338..402] tool_sig  [u8;64]
//   [402]     confidence u8
//   [403..405] tool_count u16 LE
//   [405..413] updated_at i64 LE

fn ix_register(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 413 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let record_acct = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let server_id: [u8; 36] = data[0..36].try_into().unwrap();
    let url: [u8; 200] = data[36..236].try_into().unwrap();
    let url_len = data[236];
    let title: [u8; 100] = data[237..337].try_into().unwrap();
    let title_len = data[337];
    let tool_sig: [u8; 64] = data[338..402].try_into().unwrap();
    let confidence = data[402];
    let tool_count = u16::from_le_bytes(data[403..405].try_into().unwrap());
    let updated_at = i64::from_le_bytes(data[405..413].try_into().unwrap());

    // Seeds capped at 32 bytes — use first 32 of the 36-char UUID.
    let id_seed = &server_id[..32];
    let (pda, bump) = Pubkey::find_program_address(&[b"server", id_seed], program_id);
    if pda != *record_acct.key {
        msg!("PDA mismatch: expected {}", pda);
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(RECORD_SIZE);

    invoke_signed(
        &system_instruction::create_account(
            authority.key,
            record_acct.key,
            lamports,
            RECORD_SIZE as u64,
            program_id,
        ),
        &[authority.clone(), record_acct.clone(), system_prog.clone()],
        &[&[b"server", id_seed, &[bump]]],
    )?;

    pack_record(
        &mut record_acct.data.borrow_mut(),
        authority.key,
        &server_id,
        &url,
        url_len,
        &title,
        title_len,
        &tool_sig,
        confidence,
        tool_count,
        1,
        updated_at,
        bump,
    );
    Ok(())
}

// ── update_server ─────────────────────────────────────────────────────────────
//
// Args layout (after discriminant byte):
//   [0..64]  tool_sig   [u8;64]
//   [64]     confidence u8
//   [65..67] tool_count u16 LE
//   [67..75] updated_at i64 LE

fn ix_update(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 75 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let record_acct = next_account_info(iter)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut d = record_acct.data.borrow_mut();
    if d[0] != DISCRIMINANT {
        return Err(ProgramError::InvalidAccountData);
    }

    // authority is stored at bytes 1..33
    let stored_auth = Pubkey::try_from(&d[1..33]).map_err(|_| ProgramError::InvalidAccountData)?;
    if stored_auth != *authority.key {
        return Err(ProgramError::IllegalOwner);
    }

    let tool_sig: [u8; 64] = data[0..64].try_into().unwrap();
    let confidence = data[64];
    let tool_count = u16::from_le_bytes(data[65..67].try_into().unwrap());
    let updated_at = i64::from_le_bytes(data[67..75].try_into().unwrap());

    // Read current version and bump it
    let version = u32::from_le_bytes(d[438..442].try_into().unwrap());

    d[371..435].copy_from_slice(&tool_sig);
    d[435] = confidence;
    d[436..438].copy_from_slice(&tool_count.to_le_bytes());
    d[438..442].copy_from_slice(&(version + 1).to_le_bytes());
    d[442..450].copy_from_slice(&updated_at.to_le_bytes());
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn pack_record(
    data: &mut [u8],
    authority: &Pubkey,
    server_id: &[u8; 36],
    url: &[u8; 200],
    url_len: u8,
    title: &[u8; 100],
    title_len: u8,
    tool_sig: &[u8; 64],
    confidence: u8,
    tool_count: u16,
    version: u32,
    updated_at: i64,
    bump: u8,
) {
    data[0] = DISCRIMINANT;
    data[1..33].copy_from_slice(authority.as_ref());
    data[33..69].copy_from_slice(server_id);
    data[69..269].copy_from_slice(url);
    data[269] = url_len;
    data[270..370].copy_from_slice(title);
    data[370] = title_len;
    data[371..435].copy_from_slice(tool_sig);
    data[435] = confidence;
    data[436..438].copy_from_slice(&tool_count.to_le_bytes());
    data[438..442].copy_from_slice(&version.to_le_bytes());
    data[442..450].copy_from_slice(&updated_at.to_le_bytes());
    data[450] = bump;
}
